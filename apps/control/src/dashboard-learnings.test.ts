import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { drizzleLearningStore, type NewLearning } from "@lgtmoose/learnings";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALLBACK_PATH, handleDashboardRequest, type DashboardDeps } from "./dashboard.js";
import type { DashboardGitHub } from "./dashboard-github.js";
import { SESSION_COOKIE, SIGN_IN_COOKIE, type DashboardRequest } from "./dashboard-http.js";
import { drizzleDashboardStore } from "./dashboard-store.js";

/**
 * The dashboard's learnings queue, usage and acceptance pages (NIC-840 part 2), against the real
 * Postgres stores: approving and rejecting go through the learnings policy with what GitHub said
 * about the signed-in person at sign-in.
 */

const ORIGIN = "https://d123.cloudfront.net";
const NOW = new Date("2026-11-15T10:00:00Z");
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const learnings = drizzleLearningStore(db);
const store = drizzleDashboardStore(db);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

function github(role: "admin" | "member"): DashboardGitHub {
  return {
    exchangeCode: async () => ({ token: "gho_user", expiresInSeconds: 28_800 }),
    login: async () => "Alice",
    orgRole: async (_token, org) => (org === "acme" ? role : "none"),
    // Write on acme/api only; acme/web is read only.
    visibleRepos: async () => ({ repos: ["acme/api", "acme/web"], writeRepos: ["acme/api"] }),
  };
}

function deps(role: "admin" | "member", report?: unknown): DashboardDeps {
  return {
    store,
    learnings,
    feedbackReport: async () => report,
    github: github(role),
    oauthClient: async () => ({ clientId: "c", clientSecret: "s" }),
    signingKey: async () => Buffer.from("k".repeat(64)),
    origin: async () => ORIGIN,
    allowedOrgs: ["acme"],
    now: () => NOW,
    log: () => undefined,
  };
}

function request(
  method: string,
  path: string,
  options: Partial<Omit<DashboardRequest, "method" | "path">> = {},
): DashboardRequest {
  return { method, path, query: {}, headers: {}, cookies: {}, ...options };
}

async function signIn(d: DashboardDeps): Promise<Record<string, string>> {
  const started = await handleDashboardRequest(d, request("GET", "/api/auth/login"));
  const state = new URL(started.headers.location ?? "").searchParams.get("state") ?? "";
  const signInCookie = (started.cookies[0] ?? "").split(";")[0]?.split("=").slice(1).join("=");
  const back = await handleDashboardRequest(
    d,
    request("GET", CALLBACK_PATH, {
      query: { code: "c", state },
      cookies: { [SIGN_IN_COOKIE]: signInCookie ?? "" },
    }),
  );
  const session = back.cookies
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))
    ?.split(";")[0]
    ?.slice(SESSION_COOKIE.length + 1);
  return { [SESSION_COOKIE]: session ?? "" };
}

const SAME_ORIGIN = { origin: ORIGIN, "sec-fetch-site": "same-origin" };

let next = 1;
async function learning(overrides: Partial<NewLearning>): Promise<string> {
  const n = next++;
  const { learning: stored } = await learnings.insert(
    {
      org: "acme",
      repo: "acme/api",
      pathGlob: undefined,
      kind: "convention",
      category: undefined,
      text: `<img src=x onerror=alert(${n})> learning ${n}`,
      status: "pending",
      sourceRepo: "acme/api",
      sourcePr: 1,
      sourceCommentId: 1000 + n,
      author: "bob",
      authorPermission: "read",
      ...overrides,
    },
    [{ type: "proposed", actor: "bob", actorPermission: "read", githubCommentId: 1000 + n }],
  );
  return stored.id;
}

async function act(
  d: DashboardDeps,
  cookies: Record<string, string>,
  id: string,
  action: "approve" | "reject",
  headers: Record<string, string> = SAME_ORIGIN,
) {
  const response = await handleDashboardRequest(
    d,
    request("POST", `/api/learnings/${id}/${action}`, { cookies, headers }),
  );
  return {
    status: response.status,
    body: JSON.parse(response.body || "{}") as Record<string, unknown>,
  };
}

describe("dashboard learnings", () => {
  it("lists pending learnings in the person's repositories and orgs only, text as stored", async () => {
    const mine = await learning({ repo: "acme/api" });
    const orgWide = await learning({ repo: undefined, sourceRepo: "acme/api" });
    await learning({ repo: "acme/secret", sourceRepo: "acme/secret" });
    await learning({ org: "other", repo: "other/x", sourceRepo: "other/x" });
    const d = deps("member");
    const cookies = await signIn(d);
    const response = await handleDashboardRequest(
      d,
      request("GET", "/api/learnings", { cookies, query: { status: "pending" } }),
    );
    const { learnings: listed } = JSON.parse(response.body) as {
      learnings: { id: string; text: string; repo?: string }[];
    };
    const ids = listed.map((entry) => entry.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(orgWide);
    expect(listed.every((entry) => entry.repo === undefined || entry.repo === "acme/api")).toBe(
      true,
    );
    expect(listed.find((entry) => entry.id === mine)?.text).toContain("<img src=x");
    const bad = await handleDashboardRequest(
      d,
      request("GET", "/api/learnings", { cookies, query: { status: "everything" } }),
    );
    expect(bad.status).toBe(400);
  });

  it("approves a learning in a repository the person can write to, as them", async () => {
    const id = await learning({ repo: "acme/api" });
    const d = deps("member");
    const cookies = await signIn(d);
    const result = await act(d, cookies, id, "approve");
    expect(result.status).toBe(200);
    expect(result.body.outcome).toBe("done");
    expect((await learnings.get(id))?.status).toBe("active");
    const events = await learnings.events(id);
    expect(events.at(-1)).toMatchObject({
      type: "approved",
      actor: "Alice",
      actorPermission: "write",
    });
  });

  it("refuses to approve in a repository the person can only read", async () => {
    const id = await learning({ repo: "acme/web", sourceRepo: "acme/web" });
    const d = deps("member");
    const cookies = await signIn(d);
    const result = await act(d, cookies, id, "approve");
    expect(result.status).toBe(403);
    expect((await learnings.get(id))?.status).toBe("pending");
  });

  it("approves an org-wide learning only for an owner of the org", async () => {
    const id = await learning({ repo: undefined });
    const member = deps("member");
    const asMember = await act(member, await signIn(member), id, "approve");
    expect(asMember.status).toBe(403);
    expect((await learnings.get(id))?.status).toBe("pending");
    const owner = deps("admin");
    const asOwner = await act(owner, await signIn(owner), id, "approve");
    expect(asOwner.status).toBe(200);
    const events = await learnings.events(id);
    expect(events.at(-1)).toMatchObject({ actor: "Alice", actorPermission: "org:admin" });
  });

  it("rejects (retires) a pending or active learning, keeping its history", async () => {
    const id = await learning({ repo: "acme/api", status: "active" });
    const d = deps("member");
    const cookies = await signIn(d);
    const result = await act(d, cookies, id, "reject");
    expect(result.status).toBe(200);
    expect((await learnings.get(id))?.status).toBe("retired");
    expect((await learnings.events(id)).map((event) => event.type)).toContain("retired");
  });

  it("answers 404 for a learning outside the person's repositories, and changes nothing", async () => {
    const id = await learning({ repo: "acme/secret", sourceRepo: "acme/secret" });
    const d = deps("admin");
    const cookies = await signIn(d);
    expect((await act(d, cookies, id, "approve")).status).toBe(404);
    expect((await act(d, cookies, "not-a-uuid", "approve")).status).toBe(404);
    expect((await learnings.get(id))?.status).toBe("pending");
  });

  it("refuses an approval from another origin or site", async () => {
    const id = await learning({ repo: "acme/api" });
    const d = deps("member");
    const cookies = await signIn(d);
    for (const headers of [
      {},
      { origin: "https://evil.example" },
      { origin: ORIGIN, "sec-fetch-site": "cross-site" },
    ]) {
      expect((await act(d, cookies, id, "approve", headers)).status).toBe(403);
    }
    expect((await learnings.get(id))?.status).toBe("pending");
  });

  it("needs a session to change a learning", async () => {
    const id = await learning({ repo: "acme/api" });
    const result = await act(deps("member"), {}, id, "approve");
    expect(result.status).toBe(401);
  });
});

describe("dashboard acceptance", () => {
  const report = {
    version: 1,
    generatedAt: NOW.toISOString(),
    windowDays: 90,
    threshold: 0.5,
    minSamples: 10,
    categories: [
      {
        category: "security",
        protected: false,
        findings: 12,
        fixed: 6,
        declined: 4,
        disputed: 0,
        thumbsUp: 1,
        thumbsDown: 2,
        accepted: 6,
        rejected: 4,
        acceptance: 0.6,
        flagged: false,
      },
    ],
    declined: [
      {
        repo: "Acme/API",
        prNumber: 3,
        path: "a.ts",
        line: 1,
        side: "RIGHT",
        category: "security",
        severity: "should_fix",
        title: "t",
        raisedAtSha: "a".repeat(40),
        baseSha: "b".repeat(40),
      },
      {
        repo: "acme/secret",
        prNumber: 4,
        path: "b.ts",
        line: 2,
        side: "RIGHT",
        category: "security",
        severity: "nit",
        title: "hidden",
        raisedAtSha: "a".repeat(40),
        baseSha: "b".repeat(40),
      },
    ],
  };

  it("shows the categories, and declined findings only in the person's repositories", async () => {
    const d = deps("member", report);
    const cookies = await signIn(d);
    const response = await handleDashboardRequest(
      d,
      request("GET", "/api/acceptance", { cookies }),
    );
    const body = JSON.parse(response.body) as {
      report: { categories: unknown[]; declined: { repo: string }[] };
    };
    expect(body.report.categories).toHaveLength(1);
    expect(body.report.declined.map((entry) => entry.repo)).toEqual(["Acme/API"]);
  });

  it("answers no report when there's none, or it doesn't validate", async () => {
    for (const stored of [undefined, { version: 2 }]) {
      const d = deps("member", stored);
      const cookies = await signIn(d);
      const response = await handleDashboardRequest(
        d,
        request("GET", "/api/acceptance", { cookies }),
      );
      expect(JSON.parse(response.body)).toEqual({ report: null });
    }
  });
});

describe("dashboard usage", () => {
  it("answers provider usage in scope and the deployment's cooldowns", async () => {
    const d = deps("member");
    const cookies = await signIn(d);
    const response = await handleDashboardRequest(d, request("GET", "/api/usage", { cookies }));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ days: 30, providers: [], cooldowns: [] });
  });
});
