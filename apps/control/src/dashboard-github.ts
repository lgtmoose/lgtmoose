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
  /**
   * What the token may do on `repo` (owner/name) (NIC-1140): the person's own permission as
   * GitHub reports it, limited by what the token itself can do.
   *
   * - `write`: the person has push, maintain or admin, and the token is a classic or OAuth token
   *   whose scopes (`X-OAuth-Scopes`) include `repo`, or `public_repo` on a public repository.
   *   `gh auth token` is one.
   * - `token-read-only`: the person could write, but the token can't be shown to: a classic
   *   token without those scopes, or a fine-grained or App token, whose permissions GitHub
   *   doesn't report. Such a token can list, not answer.
   * - `read`: the person can see the repository and no more. `none`: GitHub answers 404.
   */
  repoAccess(token: string, repo: string): Promise<RepoAccess>;
  /**
   * Whether the token's person is an active member of `org` (NIC-1140), as sign-in asks:
   * `unreadable` when the token can't be shown membership: a classic token whose
   * `X-OAuth-Scopes` lack an org scope (GitHub answers 403 or 404). Any other 403 (a
   * fine-grained token without the Members permission, an IP allow list, an OAuth app
   * restriction) is thrown, with GitHub's message.
   */
  membership(token: string, org: string): Promise<"member" | "none" | "unreadable">;
}

/** What a token may do on a repository (see `DashboardGitHub.repoAccess`). */
export type RepoAccess = "write" | "token-read-only" | "read" | "none";

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

/**
 * Raised when a GitHub call fails; its message never holds a token or the reply body. `status`
 * is 0 when GitHub couldn't be reached. `sso` is set when GitHub asks for the token to be
 * authorized for an organization's SAML single sign-on (`X-GitHub-SSO`).
 */
export class DashboardGitHubError extends Error {
  readonly status: number;
  readonly sso: boolean;
  /** GitHub's rate limit, not a refusal: a 403 or 429 with no requests left or a Retry-After. */
  readonly rateLimited: boolean;
  /** The token's scopes from `X-OAuth-Scopes`, for a classic or OAuth token; null otherwise. */
  readonly oauthScopes: string | null;
  /**
   * GitHub's own `message` for a refusal (an IP allow list, an OAuth app restriction), at most
   * 200 characters: for the person to read, kept out of the error's message.
   */
  readonly githubMessage: string | undefined;
  constructor(
    what: string,
    status: number,
    sso = false,
    rateLimited = false,
    details: { oauthScopes?: string | null; githubMessage?: string } = {},
  ) {
    super(
      status === 0
        ? `GitHub couldn't be reached for ${what}.`
        : `GitHub refused ${what} (HTTP ${status}).`,
    );
    this.name = "DashboardGitHubError";
    this.status = status;
    this.sso = sso;
    this.rateLimited = rateLimited;
    this.oauthScopes = details.oauthScopes ?? null;
    this.githubMessage = details.githubMessage;
  }
}

/** The classic token scopes that let GitHub show org memberships (`user` includes them). */
const ORG_SCOPES = ["read:org", "write:org", "admin:org", "user"];

/** Whether `X-OAuth-Scopes` (a classic or OAuth token's) has an org scope. */
function hasOrgScope(scopes: string): boolean {
  const granted = new Set(scopes.split(",").map((scope) => scope.trim()));
  return ORG_SCOPES.some((scope) => granted.has(scope));
}

const messageReply = z.object({ message: z.string() });

const PAGE = 100;

const repoReply = z.object({
  private: z.boolean().optional(),
  permissions: z
    .object({
      admin: z.boolean().optional(),
      maintain: z.boolean().optional(),
      push: z.boolean().optional(),
      pull: z.boolean().optional(),
    })
    .optional(),
});

export function githubDashboard(
  options: { apiUrl?: string; webUrl?: string; timeoutMs?: number; fetch?: Fetch } = {},
): DashboardGitHub {
  const api = options.apiUrl ?? "https://api.github.com";
  const web = options.webUrl ?? "https://github.com";
  const fetchFn: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = options.timeoutMs ?? 10_000;
  const get = async (token: string, path: string, what: string): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchFn(`${api}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "lgtmoose-dashboard",
        },
        // Never followed, so the token never goes on; a redirect is answered below.
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      // A timeout or the network: GitHub couldn't be reached.
      throw new DashboardGitHubError(what, 0);
    }
    // GitHub redirects a renamed or transferred repository (301): it has moved.
    if (response.status >= 300 && response.status < 400) {
      throw new DashboardGitHubError(what, response.status);
    }
    if (!response.ok && response.status !== 404) {
      const limited =
        (response.status === 403 || response.status === 429) &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after"));
      const message = messageReply.safeParse(await response.json().catch(() => undefined));
      throw new DashboardGitHubError(
        what,
        response.status,
        response.headers.has("x-github-sso"),
        limited,
        {
          oauthScopes: response.headers.get("x-oauth-scopes"),
          ...(message.success ? { githubMessage: message.data.message.slice(0, 200) } : {}),
        },
      );
    }
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
    async membership(token, org) {
      let response: Response;
      try {
        response = await get(
          token,
          `/user/memberships/orgs/${encodeURIComponent(org)}`,
          "reading an org membership",
        );
      } catch (error) {
        // A classic token whose scopes lack an org scope: it can't be shown memberships. Any
        // other 403 (an IP allow list, an OAuth app restriction) is GitHub refusing: passed on.
        if (
          error instanceof DashboardGitHubError &&
          error.status === 403 &&
          !error.sso &&
          !error.rateLimited &&
          error.oauthScopes !== null &&
          !hasOrgScope(error.oauthScopes)
        ) {
          return "unreadable";
        }
        throw error;
      }
      if (response.status === 404) {
        // Not a member, or a classic token GitHub won't show it to: its scopes say which.
        const scopes = response.headers.get("x-oauth-scopes");
        if (scopes === null) return "none";
        return hasOrgScope(scopes) ? "none" : "unreadable";
      }
      const reply = membershipReply.safeParse(await response.json());
      return reply.success && reply.data.state === "active" ? "member" : "none";
    },
    async repoAccess(token, repo) {
      const [owner = "", name = ""] = repo.split("/");
      const response = await get(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        "reading a repository",
      );
      if (!response.ok) return "none";
      const can = repoReply.safeParse(await response.json());
      if (!can.success) return "none";
      const permissions = can.data.permissions;
      // A public repository answers anyone; only a token GitHub says can pull it reads it.
      if (permissions?.pull !== true) return "none";
      if (
        permissions.push !== true &&
        permissions.maintain !== true &&
        permissions.admin !== true
      ) {
        return "read";
      }
      // The person may write; may the token? Only a classic or OAuth token says (its scopes).
      // A fine-grained or App token's permissions aren't reported, so it can't be shown to.
      const scopes = response.headers.get("x-oauth-scopes");
      if (scopes === null) return "token-read-only";
      const granted = new Set(scopes.split(",").map((scope) => scope.trim()));
      if (granted.has("repo") || (can.data.private === false && granted.has("public_repo"))) {
        return "write";
      }
      return "token-read-only";
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
