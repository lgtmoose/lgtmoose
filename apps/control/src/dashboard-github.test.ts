import { describe, expect, it } from "vitest";
import { authorizeUrl, githubDashboard } from "./dashboard-github.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(
  routes: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = url.replace(/^https:\/\/[^/]+/, "");
    const route = routes[path];
    if (route === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      ...(route.headers === undefined ? {} : { headers: route.headers }),
    });
  };
  return { fetch, calls };
}

describe("authorizeUrl", () => {
  it("asks for an S256 PKCE challenge and no scopes", () => {
    const url = new URL(
      authorizeUrl({ clientId: "c", redirectUri: "https://d/cb", state: "s", codeChallenge: "x" }),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("githubDashboard", () => {
  it("exchanges the code with the verifier and the client secret in the body", async () => {
    const { fetch, calls } = fakeFetch({
      "/login/oauth/access_token": { body: { access_token: "gho_1", expires_in: 28800 } },
    });
    const github = githubDashboard({ fetch });
    expect(
      await github.exchangeCode({
        clientId: "c",
        clientSecret: "s",
        code: "k",
        redirectUri: "https://d/cb",
        verifier: "v",
      }),
    ).toEqual({ token: "gho_1", expiresInSeconds: 28800 });
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({
      client_secret: "s",
      code_verifier: "v",
    });
  });

  it("treats GitHub's error reply as no token", async () => {
    const { fetch } = fakeFetch({
      "/login/oauth/access_token": { body: { error: "bad_verification_code" } },
    });
    const github = githubDashboard({ fetch });
    expect(
      await github.exchangeCode({
        clientId: "c",
        clientSecret: "s",
        code: "k",
        redirectUri: "r",
        verifier: "v",
      }),
    ).toBeUndefined();
  });

  it("reads the person's role from active memberships only", async () => {
    const { fetch } = fakeFetch({
      "/user/memberships/orgs/acme": { body: { state: "active", role: "member" } },
      "/user/memberships/orgs/owned": { body: { state: "active", role: "admin" } },
      "/user/memberships/orgs/pending": { body: { state: "pending", role: "admin" } },
    });
    const github = githubDashboard({ fetch });
    expect(await github.orgRole("t", "acme")).toBe("member");
    expect(await github.orgRole("t", "owned")).toBe("admin");
    expect(await github.orgRole("t", "pending")).toBe("none");
    expect(await github.orgRole("t", "nope")).toBe("none");
  });

  it("lists the repositories of allowed owners' installations only, with the person's token", async () => {
    const { fetch, calls } = fakeFetch({
      "/user/installations?per_page=100": {
        body: {
          installations: [
            { id: 1, account: { login: "Acme" } },
            { id: 2, account: { login: "elsewhere" } },
          ],
        },
      },
      "/user/installations/1/repositories?per_page=100&page=1": {
        body: {
          total_count: 2,
          repositories: [
            { full_name: "Acme/Web", permissions: { pull: true, push: false } },
            { full_name: "Acme/API", permissions: { pull: true, push: true } },
          ],
        },
      },
      "/user/installations/2/repositories?per_page=100&page=1": {
        body: { total_count: 1, repositories: [{ full_name: "elsewhere/x" }] },
      },
    });
    const github = githubDashboard({ fetch });
    expect(await github.visibleRepos("gho_user", new Set(["acme"]), 10)).toEqual({
      repos: ["acme/api", "acme/web"],
      writeRepos: ["acme/api"],
    });
    expect(calls.some((call) => call.url.includes("/installations/2/"))).toBe(false);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer gho_user");
  });

  it("throws an error that holds neither the token nor the reply", async () => {
    const { fetch } = fakeFetch({ "/user": { status: 500, body: { message: "gho_secret" } } });
    const github = githubDashboard({ fetch });
    await expect(github.login("gho_secret")).rejects.toThrow(
      /^GitHub refused reading the signed-in user \(HTTP 500\)\.$/,
    );
  });
});

describe("membership (NIC-1140)", () => {
  const PATH = "/user/memberships/orgs/acme";
  const ask = (route: { status?: number; body: unknown; headers?: Record<string, string> }) =>
    githubDashboard({ fetch: fakeFetch({ [PATH]: route }).fetch }).membership("t", "acme");

  it("reads an active membership", async () => {
    expect(await ask({ body: { state: "active", role: "member" } })).toBe("member");
    expect(await ask({ body: { state: "pending", role: "member" } })).toBe("none");
  });

  it("says when the token can't be shown membership", async () => {
    // A classic token with only repo: GitHub hides the membership.
    expect(await ask({ status: 404, body: {}, headers: { "x-oauth-scopes": "repo" } })).toBe(
      "unreadable",
    );
    // A fine-grained token without Members read.
    expect(await ask({ status: 403, body: {} })).toBe("unreadable");
  });

  it("is none when the token could see a membership and there isn't one", async () => {
    expect(
      await ask({ status: 404, body: {}, headers: { "x-oauth-scopes": "repo, read:org" } }),
    ).toBe("none");
    expect(await ask({ status: 404, body: {} })).toBe("none");
  });

  it("passes on SAML single sign-on and rate limits", async () => {
    await expect(
      ask({ status: 403, body: {}, headers: { "x-github-sso": "required" } }),
    ).rejects.toMatchObject({ sso: true });
    await expect(
      ask({ status: 403, body: {}, headers: { "x-ratelimit-remaining": "0" } }),
    ).rejects.toMatchObject({ rateLimited: true });
  });
});

describe("repoAccess", () => {
  const reply = (
    permissions: Record<string, boolean>,
    scopes: string | undefined,
    isPrivate = true,
  ) =>
    githubDashboard({
      fetch: fakeFetch({
        "/repos/acme/app": {
          body: { private: isPrivate, permissions },
          ...(scopes === undefined ? {} : { headers: { "x-oauth-scopes": scopes } }),
        },
      }).fetch,
    });

  it("gives write only when the person may write and the token's scopes allow it", async () => {
    const writer = { pull: true, push: true };
    expect(await reply(writer, "gist, read:org, repo").repoAccess("t", "acme/app")).toBe("write");
    expect(await reply({ pull: true, maintain: true }, "repo").repoAccess("t", "acme/app")).toBe(
      "write",
    );
    // public_repo is enough for a public repository only.
    expect(await reply(writer, "public_repo", false).repoAccess("t", "acme/app")).toBe("write");
    expect(await reply(writer, "public_repo", true).repoAccess("t", "acme/app")).toBe(
      "token-read-only",
    );
    // A classic token with no scopes, or a fine-grained token (no scopes header).
    expect(await reply(writer, "").repoAccess("t", "acme/app")).toBe("token-read-only");
    expect(await reply(writer, undefined).repoAccess("t", "acme/app")).toBe("token-read-only");
    expect(await reply({ pull: true }, "repo").repoAccess("t", "acme/app")).toBe("read");
    expect(await reply({}, "repo").repoAccess("t", "acme/app")).toBe("none");
  });

  it("is none when GitHub doesn't show the repository to the token", async () => {
    const github = githubDashboard({ fetch: fakeFetch({}).fetch });
    expect(await github.repoAccess("t", "acme/app")).toBe("none");
  });

  it("refuses a token GitHub rejects", async () => {
    const github = githubDashboard({
      fetch: fakeFetch({ "/repos/acme/app": { status: 401, body: {} } }).fetch,
    });
    await expect(github.repoAccess("t", "acme/app")).rejects.toThrow("HTTP 401");
  });

  it("says when GitHub asks for SAML single sign-on, or can't be reached", async () => {
    const sso = githubDashboard({
      fetch: fakeFetch({
        "/repos/acme/app": {
          status: 403,
          body: {},
          headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso" },
        },
      }).fetch,
    });
    await expect(sso.repoAccess("t", "acme/app")).rejects.toMatchObject({
      status: 403,
      sso: true,
    });
    const down = githubDashboard({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.repoAccess("t", "acme/app")).rejects.toMatchObject({ status: 0 });
  });

  it("doesn't follow a redirect, and says the repository moved", async () => {
    const { fetch, calls } = fakeFetch({
      "/repos/acme/app": {
        status: 301,
        body: {},
        headers: { location: "https://api.github.com/repositories/1" },
      },
    });
    await expect(githubDashboard({ fetch }).repoAccess("t", "acme/app")).rejects.toMatchObject({
      status: 301,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  it("tells GitHub's rate limit from a refusal", async () => {
    const limited = githubDashboard({
      fetch: fakeFetch({
        "/repos/acme/app": {
          status: 403,
          body: {},
          headers: { "x-ratelimit-remaining": "0" },
        },
      }).fetch,
    });
    await expect(limited.repoAccess("t", "acme/app")).rejects.toMatchObject({
      status: 403,
      rateLimited: true,
    });
    const refused = githubDashboard({
      fetch: fakeFetch({
        "/repos/acme/app": { status: 403, body: {}, headers: { "x-ratelimit-remaining": "4000" } },
      }).fetch,
    });
    await expect(refused.repoAccess("t", "acme/app")).rejects.toMatchObject({
      rateLimited: false,
    });
  });
});
