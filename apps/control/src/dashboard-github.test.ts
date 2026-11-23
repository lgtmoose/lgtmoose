import { describe, expect, it } from "vitest";
import { authorizeUrl, githubDashboard } from "./dashboard-github.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = url.replace(/^https:\/\/[^/]+/, "");
    const route = routes[path];
    if (route === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
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

describe("repoAccess", () => {
  it("reads the person's own permission on the repository", async () => {
    const reply = (permissions: Record<string, boolean>) =>
      githubDashboard({
        fetch: fakeFetch({ "/repos/acme/app": { body: { permissions } } }).fetch,
      });
    expect(await reply({ pull: true, push: true }).repoAccess("t", "acme/app")).toBe("write");
    expect(await reply({ pull: true, maintain: true }).repoAccess("t", "acme/app")).toBe("write");
    expect(await reply({ pull: true }).repoAccess("t", "acme/app")).toBe("read");
    expect(await reply({}).repoAccess("t", "acme/app")).toBe("none");
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
});
