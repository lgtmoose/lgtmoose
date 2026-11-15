import { z } from "zod";

/**
 * GitHub as the dashboard's sign-in uses it (NIC-840): the App's OAuth (user authorization) with
 * PKCE, then the signed-in person's own token to read who they are, which allowed orgs they
 * belong to and which repositories they can see through the App. The token is used during the
 * callback and then dropped: it's never stored or sent to the browser.
 */

export interface DashboardGitHub {
  /** Exchanges the callback's code for the person's token; undefined when GitHub refuses it. */
  exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<{ token: string; expiresInSeconds: number | undefined } | undefined>;
  /** The token's own login. */
  login(token: string): Promise<string>;
  /**
   * The token's person's role in `org`, from their active membership: `admin` is an owner;
   * `none` when they aren't an active member.
   */
  orgRole(token: string, org: string): Promise<"admin" | "member" | "none">;
  /**
   * Lowercased owner/name of the repositories the person can see through installations of the
   * App on `owners` (lowercased), at most `limit`, and those of them where GitHub reports the
   * person's own permission as write or more (push, maintain or admin).
   */
  visibleRepos(
    token: string,
    owners: ReadonlySet<string>,
    limit: number,
  ): Promise<{ repos: string[]; writeRepos: string[] }>;
}

/** The URL GitHub's sign-in starts at. */
export function authorizeUrl(input: {
  webUrl?: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("/login/oauth/authorize", input.webUrl ?? "https://github.com");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // A GitHub App's user token carries the App's permissions, not scopes; none are asked for.
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

const tokenReply = z.union([
  z.object({
    access_token: z.string().min(1),
    expires_in: z.coerce.number().int().positive().optional(),
  }),
  z.object({ error: z.string() }),
]);

const userReply = z.object({ login: z.string().min(1) });
const membershipReply = z.object({ state: z.string(), role: z.string().optional() });
const installationsReply = z.object({
  installations: z.array(
    z.object({ id: z.number().int(), account: z.object({ login: z.string() }).nullable() }),
  ),
});
const repositoriesReply = z.object({
  total_count: z.number().int(),
  repositories: z.array(
    z.object({
      full_name: z.string(),
      /** The person's own permission on it, as their token sees it. */
      permissions: z
        .object({
          admin: z.boolean().optional(),
          maintain: z.boolean().optional(),
          push: z.boolean().optional(),
        })
        .optional(),
    }),
  ),
});

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Raised when a GitHub call fails; its message never holds a token or the reply body. */
export class DashboardGitHubError extends Error {
  constructor(what: string, status: number) {
    super(`GitHub refused ${what} (HTTP ${status}).`);
    this.name = "DashboardGitHubError";
  }
}

const PAGE = 100;

export function githubDashboard(
  options: { apiUrl?: string; webUrl?: string; timeoutMs?: number; fetch?: Fetch } = {},
): DashboardGitHub {
  const api = options.apiUrl ?? "https://api.github.com";
  const web = options.webUrl ?? "https://github.com";
  const fetchFn: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = options.timeoutMs ?? 10_000;
  const get = async (token: string, path: string, what: string): Promise<Response> => {
    const response = await fetchFn(`${api}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "lgtmoose-dashboard",
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok && response.status !== 404)
      throw new DashboardGitHubError(what, response.status);
    return response;
  };
  return {
    async exchangeCode(input) {
      const response = await fetchFn(`${web}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "lgtmoose-dashboard",
        },
        body: JSON.stringify({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new DashboardGitHubError("the sign-in code", response.status);
      const reply = tokenReply.safeParse(await response.json());
      if (!reply.success || "error" in reply.data) return undefined;
      return { token: reply.data.access_token, expiresInSeconds: reply.data.expires_in };
    },
    async login(token) {
      const response = await get(token, "/user", "reading the signed-in user");
      if (!response.ok)
        throw new DashboardGitHubError("reading the signed-in user", response.status);
      return userReply.parse(await response.json()).login;
    },
    async orgRole(token, org) {
      const response = await get(
        token,
        `/user/memberships/orgs/${encodeURIComponent(org)}`,
        "reading an org membership",
      );
      if (!response.ok) return "none";
      const reply = membershipReply.safeParse(await response.json());
      if (!reply.success || reply.data.state !== "active") return "none";
      return reply.data.role === "admin" ? "admin" : "member";
    },
    async visibleRepos(token, owners, limit) {
      const repos = new Set<string>();
      const writeRepos = new Set<string>();
      const installations = installationsReply.parse(
        await (
          await get(token, `/user/installations?per_page=${PAGE}`, "listing installations")
        ).json(),
      ).installations;
      for (const installation of installations) {
        const owner = installation.account?.login.toLowerCase();
        if (owner === undefined || !owners.has(owner)) continue;
        for (let page = 1; repos.size < limit; page += 1) {
          const response = await get(
            token,
            `/user/installations/${installation.id}/repositories?per_page=${PAGE}&page=${page}`,
            "listing repositories",
          );
          if (!response.ok) break;
          const reply = repositoriesReply.parse(await response.json());
          for (const repo of reply.repositories) {
            const name = repo.full_name.toLowerCase();
            // Only repositories of an allowed owner, whatever the installation lists.
            if (!owners.has(name.split("/")[0] ?? "")) continue;
            repos.add(name);
            const can = repo.permissions;
            if (can?.push === true || can?.maintain === true || can?.admin === true) {
              writeRepos.add(name);
            }
            if (repos.size >= limit) break;
          }
          if (reply.repositories.length < PAGE) break;
        }
      }
      return { repos: [...repos].sort(), writeRepos: [...writeRepos].sort() };
    },
  };
}
