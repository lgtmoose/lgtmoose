import { memoryLearningStore } from "@lgtmoose/learnings";
import { describe, expect, it } from "vitest";
import { CALLBACK_PATH, handleDashboardRequest, type DashboardDeps } from "./dashboard.js";
import type { DashboardGitHub } from "./dashboard-github.js";
import {
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  fromHttpApiEvent,
  parseCookies,
  pkceChallenge,
  sha256Hex,
  sign,
  verify,
  type DashboardRequest,
} from "./dashboard-http.js";
import type { DashboardSession, DashboardStore } from "./dashboard-store.js";

const ORIGIN = "https://d123.cloudfront.net";
const KEY = Buffer.from("k".repeat(64));
const NOW = new Date("2026-11-15T10:00:00Z");

function memoryStore(): DashboardStore & { sessions: Map<string, DashboardSession> } {
  const sessions = new Map<string, DashboardSession>();
  return {
    sessions,
    async createSession(hash, session) {
      sessions.set(hash, session);
    },
    async session(hash, now) {
      const session = sessions.get(hash);
      return session !== undefined && session.expiresAt > now ? session : undefined;
    },
    async deleteSession(hash) {
      sessions.delete(hash);
    },
    async deleteExpired(now) {
      let n = 0;
      for (const [hash, session] of sessions) {
        if (session.expiresAt <= now) {
          sessions.delete(hash);
          n += 1;
        }
      }
      return n;
    },
    async repoSummaries(repos) {
      return repos.map((repo) => ({ repo, openFindings: 1, blocking: 0, lastRunAt: undefined }));
    },
    async openFindings(repos) {
      return repos.map((repo) => ({
        id: `f-${repo}`,
        repo,
        number: 1,
        severity: "blocking" as const,
        ruleCategory: "authz",
        title: "t",
        body: "b",
        path: "a.ts",
        line: 1,
        source: "self" as const,
        sourceLogin: undefined,
        createdAt: NOW.toISOString(),
      }));
    },
    async recentRuns(repos) {
      return repos.map((repo) => ({
        id: `r-${repo}`,
        repo,
        number: 1,
        headSha: "a".repeat(40),
        kind: "first",
        status: "succeeded",
        costUsd: 0.5,
        filesDone: 1,
        filesTotal: 1,
        providers: ["claude"],
        startedAt: undefined,
        finishedAt: undefined,
        createdAt: NOW.toISOString(),
      }));
    },
    async providerUse(repos) {
      return repos.length === 0
        ? []
        : [
            {
              providerId: "claude",
              batches: repos.length,
              inputTokens: 10,
              outputTokens: 5,
              costUsd: 0.25,
              limitHits: 1,
              fallbacks: 1,
            },
          ];
    },
    async cooldowns() {
      return [{ providerId: "claude", until: NOW.toISOString(), reason: "plan_limit" }];
    },
  };
}

function fakeGitHub(overrides: Partial<DashboardGitHub> = {}): DashboardGitHub & {
  exchanges: Parameters<DashboardGitHub["exchangeCode"]>[0][];
} {
  const exchanges: Parameters<DashboardGitHub["exchangeCode"]>[0][] = [];
  return {
    exchanges,
    async exchangeCode(input) {
      exchanges.push(input);
      return { token: "gho_user", expiresInSeconds: 28_800 };
    },
    async login() {
      return "Alice";
    },
    async orgRole(_token, org) {
      return org === "acme" ? "member" : "none";
    },
    async visibleRepos() {
      return { repos: ["acme/api", "acme/web"], writeRepos: ["acme/api"] };
    },
    ...overrides,
  };
}

function setup(overrides: Partial<DashboardDeps> = {}, report?: unknown) {
  const store = memoryStore();
  const github = fakeGitHub();
  const learnings = memoryLearningStore();
  const logs: string[] = [];
  const deps: DashboardDeps = {
    store,
    learnings,
    feedbackReport: async () => report,
    github,
    oauthClient: async () => ({ clientId: "Iv1.client", clientSecret: "secret" }),
    signingKey: async () => KEY,
    origin: async () => ORIGIN,
    allowedOrgs: ["acme", "other"],
    now: () => NOW,
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps, store, github, learnings, logs };
}

function request(
  method: string,
  path: string,
  options: Partial<Omit<DashboardRequest, "method" | "path">> = {},
): DashboardRequest {
  return { method, path, query: {}, headers: {}, cookies: {}, ...options };
}

/** The cookie a response sets, by name: its value and attributes. */
function cookie(
  cookies: string[],
  name: string,
): { value: string; attributes: string } | undefined {
  const found = cookies.find((entry) => entry.startsWith(`${name}=`));
  if (found === undefined) return undefined;
  const [pair = "", ...rest] = found.split("; ");
  return { value: pair.slice(name.length + 1), attributes: rest.join("; ") };
}

async function signIn(deps: DashboardDeps) {
  const started = await handleDashboardRequest(deps, request("GET", "/api/auth/login"));
  const location = new URL(started.headers.location ?? "");
  const signInCookie = cookie(started.cookies, SIGN_IN_COOKIE)?.value ?? "";
  const back = await handleDashboardRequest(
    deps,
    request("GET", CALLBACK_PATH, {
      query: { code: "code-1", state: location.searchParams.get("state") ?? "" },
      cookies: { [SIGN_IN_COOKIE]: signInCookie },
    }),
  );
  return { started, location, back, session: cookie(back.cookies, SESSION_COOKIE)?.value };
}

describe("dashboard sign-in", () => {
  it("sends the browser to GitHub with state and a PKCE challenge, keeping the verifier in a signed cookie", async () => {
    const { deps } = setup();
    const { started, location } = await signIn(deps);
    expect(started.status).toBe(302);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.client");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}${CALLBACK_PATH}`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const set = cookie(started.cookies, SIGN_IN_COOKIE);
    expect(set?.attributes).toBe("Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax");
    const stored = verify(KEY, set?.value) as { state: string; verifier: string };
    expect(stored.state).toBe(location.searchParams.get("state"));
    expect(location.searchParams.get("code_challenge")).toBe(pkceChallenge(stored.verifier));
  });

  it("exchanges the code with the verifier and starts a session for a member", async () => {
    const { deps, store, github } = setup();
    const { back, session } = await signIn(deps);
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe("/");
    expect(github.exchanges[0]).toMatchObject({
      clientSecret: "secret",
      code: "code-1",
      redirectUri: `${ORIGIN}${CALLBACK_PATH}`,
    });
    expect(github.exchanges[0]?.verifier.length).toBeGreaterThanOrEqual(43);
    expect(cookie(back.cookies, SIGN_IN_COOKIE)?.attributes).toContain("Max-Age=0");
    const set = cookie(back.cookies, SESSION_COOKIE);
    expect(set?.attributes).toBe("Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax");
    // Only the token's hash is kept, with what GitHub said at sign-in; no GitHub token.
    expect([...store.sessions.keys()]).toEqual([sha256Hex(session ?? "")]);
    const stored = store.sessions.get(sha256Hex(session ?? ""));
    expect(stored).toMatchObject({
      login: "Alice",
      orgs: ["acme"],
      repos: ["acme/api", "acme/web"],
    });
    expect(JSON.stringify(stored)).not.toContain("gho_user");
  });

  it("refuses someone who isn't a member of an allowed org", async () => {
    const { deps, store } = setup({ github: fakeGitHub({ orgRole: async () => "none" }) });
    const { back, session } = await signIn(deps);
    expect(back.headers.location).toBe("/#/signed-out?error=not-member");
    expect(session).toBeUndefined();
    expect(store.sessions.size).toBe(0);
  });

  it("counts a user account in allowedOrgs as its own owner's", async () => {
    const { deps, store } = setup({
      allowedOrgs: ["alice"],
      github: fakeGitHub({
        orgRole: async () => "none",
        visibleRepos: async () => ({ repos: ["alice/x"], writeRepos: [] }),
      }),
    });
    const { session } = await signIn(deps);
    expect(store.sessions.get(sha256Hex(session ?? ""))?.orgs).toEqual(["alice"]);
  });

  it("refuses a callback whose state doesn't match, or without the sign-in cookie", async () => {
    const { deps, github } = setup();
    const started = await handleDashboardRequest(deps, request("GET", "/api/auth/login"));
    const signInCookie = cookie(started.cookies, SIGN_IN_COOKIE)?.value ?? "";
    const wrong = await handleDashboardRequest(
      deps,
      request("GET", CALLBACK_PATH, {
        query: { code: "c", state: "x".repeat(43) },
        cookies: { [SIGN_IN_COOKIE]: signInCookie },
      }),
    );
    expect(wrong.headers.location).toBe("/#/signed-out?error=expired");
    const state = new URL(started.headers.location ?? "").searchParams.get("state") ?? "";
    const noCookie = await handleDashboardRequest(
      deps,
      request("GET", CALLBACK_PATH, { query: { code: "c", state } }),
    );
    expect(noCookie.headers.location).toBe("/#/signed-out?error=expired");
    expect(github.exchanges).toEqual([]);
  });

  it("refuses a forged or expired sign-in cookie", async () => {
    const { deps, github } = setup();
    const forged = sign(Buffer.from("x".repeat(64)), {
      state: "s".repeat(43),
      verifier: "v".repeat(64),
      expiresAt: NOW.getTime() + 60_000,
    });
    const expired = sign(KEY, {
      state: "s".repeat(43),
      verifier: "v".repeat(64),
      expiresAt: NOW.getTime() - 1,
    });
    for (const value of [forged, expired]) {
      const response = await handleDashboardRequest(
        deps,
        request("GET", CALLBACK_PATH, {
          query: { code: "c", state: "s".repeat(43) },
          cookies: { [SIGN_IN_COOKIE]: value },
        }),
      );
      expect(response.headers.location).toBe("/#/signed-out?error=expired");
    }
    expect(github.exchanges).toEqual([]);
  });

  it("says when GitHub's sign-in was declined, or the OAuth client isn't stored", async () => {
    const { deps } = setup();
    const declined = await handleDashboardRequest(
      deps,
      request("GET", CALLBACK_PATH, { query: { error: "access_denied" } }),
    );
    expect(declined.headers.location).toBe("/#/signed-out?error=denied");
    const unset = setup({ oauthClient: async () => undefined });
    const login = await handleDashboardRequest(unset.deps, request("GET", "/api/auth/login"));
    expect(login.headers.location).toBe("/#/signed-out?error=not-configured");
  });

  it("logs and reports a GitHub failure without its details", async () => {
    const { deps, logs } = setup({
      github: fakeGitHub({
        login: async () => {
          throw new Error("boom");
        },
      }),
    });
    const { back } = await signIn(deps);
    expect(back.headers.location).toBe("/#/signed-out?error=github");
    expect(logs).toContain("dashboard sign-in failed");
  });

  it("ends a session no later than GitHub's token would", async () => {
    const { deps } = setup({
      github: fakeGitHub({
        exchangeCode: async () => ({ token: "t", expiresInSeconds: 600 }),
      }),
    });
    const { back } = await signIn(deps);
    expect(cookie(back.cookies, SESSION_COOKIE)?.attributes).toContain("Max-Age=600");
  });
});

describe("dashboard API", () => {
  async function signedIn() {
    const context = setup();
    const { session } = await signIn(context.deps);
    return { ...context, cookies: { [SESSION_COOKIE]: session ?? "" } };
  }

  it("answers 401 without a session, and clears a cookie it doesn't know", async () => {
    const { deps } = setup();
    const none = await handleDashboardRequest(deps, request("GET", "/api/me"));
    expect(none.status).toBe(401);
    expect(none.cookies).toEqual([]);
    const unknown = await handleDashboardRequest(
      deps,
      request("GET", "/api/me", { cookies: { [SESSION_COOKIE]: "made-up" } }),
    );
    expect(unknown.status).toBe(401);
    expect(cookie(unknown.cookies, SESSION_COOKIE)?.attributes).toContain("Max-Age=0");
  });

  it("answers who is signed in, never cached", async () => {
    const { deps, cookies } = await signedIn();
    const me = await handleDashboardRequest(deps, request("GET", "/api/me", { cookies }));
    expect(me.status).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(me.body)).toMatchObject({ login: "Alice", orgs: ["acme"], repos: 2 });
  });

  it("lists findings and runs only in the repositories the person can see", async () => {
    const { deps, cookies } = await signedIn();
    const all = JSON.parse(
      (await handleDashboardRequest(deps, request("GET", "/api/findings", { cookies }))).body,
    ) as { findings: { repo: string }[] };
    expect(all.findings.map((f) => f.repo)).toEqual(["acme/api", "acme/web"]);
    const one = JSON.parse(
      (
        await handleDashboardRequest(
          deps,
          request("GET", "/api/runs", { cookies, query: { repo: "Acme/API" } }),
        )
      ).body,
    ) as { runs: { repo: string }[] };
    expect(one.runs.map((r) => r.repo)).toEqual(["acme/api"]);
    for (const repo of ["acme/secret", "other/x", "../etc", "acme/api,acme/x"]) {
      const response = await handleDashboardRequest(
        deps,
        request("GET", "/api/findings", { cookies, query: { repo } }),
      );
      expect(response.status).toBe(404);
    }
  });

  it("refuses a state-changing request from another origin", async () => {
    const { deps, store, cookies } = await signedIn();
    for (const headers of [
      {},
      { origin: "https://evil.example" },
      { origin: ORIGIN, "sec-fetch-site": "cross-site" },
    ]) {
      const response = await handleDashboardRequest(
        deps,
        request("POST", "/api/auth/logout", { cookies, headers }),
      );
      expect(response.status).toBe(403);
    }
    expect(store.sessions.size).toBe(1);
  });

  it("signs out: the session is deleted and the cookie cleared", async () => {
    const { deps, store, cookies } = await signedIn();
    const response = await handleDashboardRequest(
      deps,
      request("POST", "/api/auth/logout", {
        cookies,
        headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
      }),
    );
    expect(response.status).toBe(204);
    expect(cookie(response.cookies, SESSION_COOKIE)?.attributes).toContain("Max-Age=0");
    expect(store.sessions.size).toBe(0);
    const after = await handleDashboardRequest(deps, request("GET", "/api/me", { cookies }));
    expect(after.status).toBe(401);
  });

  it("answers 404 for anything else", async () => {
    const { deps, cookies } = await signedIn();
    const response = await handleDashboardRequest(deps, request("GET", "/api/nope", { cookies }));
    expect(response.status).toBe(404);
  });
});

describe("dashboard HTTP plumbing", () => {
  it("reads an HTTP API event: method, path, lower-cased headers and cookies", () => {
    const parsed = fromHttpApiEvent({
      rawPath: "/api/me",
      requestContext: { http: { method: "get" } },
      headers: { Origin: ORIGIN },
      cookies: [`${SESSION_COOKIE}=abc`, "other=1"],
      queryStringParameters: { repo: "acme/api" },
    });
    expect(parsed).toEqual({
      method: "GET",
      path: "/api/me",
      headers: { origin: ORIGIN },
      cookies: { [SESSION_COOKIE]: "abc", other: "1" },
      query: { repo: "acme/api" },
    });
  });

  it("keeps the first cookie of a name", () => {
    expect(parseCookies(["a=1; b=2", "a=3"])).toEqual({ a: "1", b: "2" });
  });

  it("rejects a signed value that was changed", () => {
    const signed = sign(KEY, { a: 1 });
    expect(verify(KEY, signed)).toEqual({ a: 1 });
    expect(verify(KEY, `${signed.slice(0, -2)}xx`)).toBeUndefined();
    expect(verify(KEY, "garbage")).toBeUndefined();
  });
});
