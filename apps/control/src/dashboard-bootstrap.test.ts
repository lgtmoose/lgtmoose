import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { drizzleLearningStore, type NewLearning } from "@lgtmoose/learnings";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleBootstrapStore, type Bootstrap, type RequestResult } from "./bootstrap-store.js";
import { CALLBACK_PATH, handleDashboardRequest, type DashboardDeps } from "./dashboard.js";
import type { DashboardGitHub } from "./dashboard-github.js";
import { SESSION_COOKIE, SIGN_IN_COOKIE, type DashboardRequest } from "./dashboard-http.js";
import { drizzleDashboardStore } from "./dashboard-store.js";

/**
 * Learning from review history on the dashboard (NIC-1080), against the real Postgres stores:
 * asking for a bootstrap needs write access as GitHub said at sign-in, and approving what it
 * proposed goes through the learnings policy, one learning at a time.
 */

const ORIGIN = "https://d123.cloudfront.net";
const NOW = new Date("2026-11-15T10:00:00Z");
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const learnings = drizzleLearningStore(db);
const bootstraps = drizzleBootstrapStore(db, () => NOW);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

const github: DashboardGitHub = {
  exchangeCode: async () => ({ token: "gho_user", expiresInSeconds: 28_800 }),
  login: async () => "Alice",
  orgRole: async (_token, org) => (org === "acme" ? "member" : "none"),
  // Write on acme/api only; acme/web is read only.
  visibleRepos: async () => ({ repos: ["acme/api", "acme/web"], writeRepos: ["acme/api"] }),
};

const deps: DashboardDeps = {
  store: drizzleDashboardStore(db),
  learnings,
  bootstraps: { store: bootstraps, maxPrs: 200 },
  feedbackReport: async () => undefined,
  github,
  oauthClient: async () => ({ clientId: "c", clientSecret: "s" }),
  signingKey: async () => Buffer.from("k".repeat(64)),
  origin: async () => ORIGIN,
  allowedOrgs: ["acme"],
  now: () => NOW,
  log: () => undefined,
};

function request(
  method: string,
  path: string,
  options: Partial<Omit<DashboardRequest, "method" | "path">> = {},
): DashboardRequest {
  return { method, path, query: {}, headers: {}, cookies: {}, ...options };
}

async function signIn(): Promise<Record<string, string>> {
  const started = await handleDashboardRequest(deps, request("GET", "/api/auth/login"));
  const state = new URL(started.headers.location ?? "").searchParams.get("state") ?? "";
  const signInCookie = (started.cookies[0] ?? "").split(";")[0]?.split("=").slice(1).join("=");
  const back = await handleDashboardRequest(
    deps,
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

async function call(
  cookies: Record<string, string>,
  method: string,
  path: string,
  query: Record<string, string> = {},
) {
  const response = await handleDashboardRequest(
    deps,
    request(method, path, { cookies, query, headers: method === "GET" ? {} : SAME_ORIGIN }),
  );
  return {
    status: response.status,
    body: JSON.parse(response.body || "{}") as Record<string, unknown>,
  };
}

const bootstrapOf = (result: RequestResult): Bootstrap =>
  result.created ? result.bootstrap : result.active;

let next = 1;
/** A pending learning a bootstrap proposed, by LGTMoose. */
async function proposed(overrides: Partial<NewLearning> = {}): Promise<string> {
  next += 1;
  const { learning } = await learnings.insert(
    {
      org: "acme",
      repo: "acme/api",
      pathGlob: undefined,
      kind: "convention",
      category: undefined,
      text: `Rule ${next}.`,
      status: "pending",
      sourceRepo: "acme/api",
      sourcePr: undefined,
      sourceCommentId: undefined,
      author: "lgtmoose",
      authorPermission: "system",
      ...overrides,
    },
    [
      {
        type: "proposed",
        actor: "lgtmoose",
        actorPermission: "system",
        githubCommentId: undefined,
      },
    ],
  );
  return learning.id;
}

describe("dashboard bootstraps", () => {
  it("asks for one only on a repository the person can write to, once at a time", async () => {
    const cookies = await signIn();
    expect((await call(cookies, "POST", "/api/bootstraps", { repo: "acme/web" })).status).toBe(403);
    expect((await call(cookies, "POST", "/api/bootstraps", { repo: "acme/secret" })).status).toBe(
      404,
    );
    expect(
      (await call(cookies, "POST", "/api/bootstraps", { repo: "acme/api", prs: "0" })).status,
    ).toBe(400);
    const asked = await call(cookies, "POST", "/api/bootstraps", { repo: "acme/api", prs: "50" });
    expect(asked).toMatchObject({
      status: 202,
      body: { bootstrap: { repo: "acme/api", status: "requested", requestedBy: "Alice" } },
    });
    expect((await call(cookies, "POST", "/api/bootstraps", { repo: "acme/api" })).status).toBe(409);
    const id = (asked.body.bootstrap as { id: string }).id;
    expect(await bootstraps.get(id)).toMatchObject({ maxPrs: 50 });
    // Another origin can't ask for one.
    const cross = await handleDashboardRequest(
      deps,
      request("POST", "/api/bootstraps", {
        cookies,
        query: { repo: "acme/api" },
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(cross.status).toBe(403);
    await bootstraps.fail(id, "cleared for the next test");
  });

  it("lists what a bootstrap proposed, and approves it all through the policy", async () => {
    const cookies = await signIn();
    // acme/web is read-only for Alice: its proposals are listed, but she can't approve them.
    const web = bootstrapOf(
      await bootstraps.request({ repo: "acme/web", requestedBy: "x", maxPrs: 10, maxCostUsd: 1 }),
    );
    const readOnly = await proposed({ repo: "acme/web", sourceRepo: "acme/web" });
    await bootstraps.addItem(web.id, readOnly, [
      { pr: 3, commentId: 31, url: "u" },
      { file: "CODEOWNERS" },
    ]);
    const listed = await call(cookies, "GET", "/api/bootstraps");
    expect(listed.body).toMatchObject({
      enabled: true,
      writeRepos: ["acme/api"],
      items: [
        {
          bootstrapId: web.id,
          learning: { id: readOnly, author: "lgtmoose" },
          sources: [{ pr: 3 }, { file: "CODEOWNERS" }],
        },
      ],
    });
    expect(await call(cookies, "POST", `/api/bootstraps/${web.id}/approve`)).toMatchObject({
      status: 200,
      body: { done: 0, refused: 1 },
    });
    expect((await learnings.get(readOnly))?.status).toBe("pending");

    // On a repository she can write to, approving all works, one event per learning.
    const api = bootstrapOf(
      await bootstraps.request({ repo: "acme/api", requestedBy: "x", maxPrs: 10, maxCostUsd: 1 }),
    );
    const a = await proposed();
    const b = await proposed();
    await bootstraps.addItem(api.id, a, [{ file: "eslint.config.js" }]);
    await bootstraps.addItem(api.id, b, [{ file: "eslint.config.js" }]);
    expect(await call(cookies, "POST", `/api/bootstraps/${api.id}/approve`)).toMatchObject({
      status: 200,
      body: { done: 2, refused: 0 },
    });
    expect((await learnings.get(a))?.status).toBe("active");
    const events = await learnings.events(b);
    expect(events.map((event) => [event.type, event.actor])).toEqual([
      ["proposed", "lgtmoose"],
      ["approved", "Alice"],
    ]);
    // Approved ones leave the queue.
    const after = await call(cookies, "GET", "/api/bootstraps");
    expect(
      (after.body.items as { learning: { id: string } }[]).map((item) => item.learning.id),
    ).toEqual([readOnly]);
  });

  it("hides another org's bootstrap", async () => {
    const cookies = await signIn();
    const other = bootstrapOf(
      await bootstraps.request({ repo: "other/x", requestedBy: "x", maxPrs: 10, maxCostUsd: 1 }),
    );
    expect((await call(cookies, "POST", `/api/bootstraps/${other.id}/approve`)).status).toBe(404);
    const listed = await call(cookies, "GET", "/api/bootstraps");
    expect(
      (listed.body.bootstraps as { repo: string }[]).some((each) => each.repo === "other/x"),
    ).toBe(false);
  });
});

describe("the bootstrap store", () => {
  it("starts a requested one once, records its progress and finish, and resumes below it", async () => {
    const asked = await bootstraps.request({
      repo: "Acme/Lib",
      requestedBy: "dev",
      maxPrs: 100,
      maxCostUsd: 3,
    });
    if (!asked.created) throw new Error("expected a new bootstrap");
    expect(asked.bootstrap).toMatchObject({ repo: "acme/lib", status: "requested", maxCostUsd: 3 });
    expect((await bootstraps.requested(50)).map((each) => each.id)).toContain(asked.bootstrap.id);
    expect(await bootstraps.start(asked.bootstrap.id, "arn:1")).toBe(true);
    expect(await bootstraps.start(asked.bootstrap.id, "arn:2")).toBe(false);
    await bootstraps.progress(asked.bootstrap.id, {
      prsRead: 40,
      commentsRead: 90,
      oldestPrRead: 17,
      capped: true,
    });
    await bootstraps.finish(asked.bootstrap.id, { proposed: 4, costUsd: 0.37 });
    expect(await bootstraps.get(asked.bootstrap.id)).toMatchObject({
      status: "done",
      prsRead: 40,
      oldestPrRead: 17,
      capped: true,
      proposed: 4,
      costUsd: 0.37,
    });
    const resumed = await bootstraps.request({
      repo: "acme/lib",
      requestedBy: "dev",
      maxPrs: 100,
      maxCostUsd: 3,
      resume: true,
    });
    expect(resumed).toMatchObject({ created: true, bootstrap: { beforePr: 17 } });
  });

  it("fails a bootstrap by its execution, and one whose execution was lost", async () => {
    const lost = bootstrapOf(
      await bootstraps.request({ repo: "acme/lost", requestedBy: "dev", maxPrs: 1, maxCostUsd: 1 }),
    );
    await bootstraps.start(lost.id, "arn:lost");
    expect(await bootstraps.failByExecution("arn:other", "x")).toBe(false);
    expect(await bootstraps.failByExecution("arn:lost", "States.TaskFailed")).toBe(true);
    expect(await bootstraps.get(lost.id)).toMatchObject({
      status: "failed",
      error: "States.TaskFailed",
    });
    const stale = bootstrapOf(
      await bootstraps.request({
        repo: "acme/stale",
        requestedBy: "dev",
        maxPrs: 1,
        maxCostUsd: 1,
      }),
    );
    await bootstraps.start(stale.id, "arn:stale");
    expect(await bootstraps.failStale(new Date(NOW.getTime() + 1000))).toBeGreaterThanOrEqual(1);
    expect((await bootstraps.get(stale.id))?.status).toBe("failed");
  });
});
