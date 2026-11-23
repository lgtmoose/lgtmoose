import { randomBytes } from "node:crypto";
import { FEEDBACK_REPORT_KEY } from "@lgtmoose/config";
import {
  ensureDashboardRole,
  findings,
  postgresArtifactStore,
  providerCooldowns,
  providerUsage,
  pullRequests,
  reviewRuns,
} from "@lgtmoose/db";
import { MIGRATIONS_FOLDER, runMigrations } from "@lgtmoose/db/migrate";
import { drizzleLearningStore } from "@lgtmoose/learnings";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleDashboardRequest, type DashboardDeps } from "../dashboard.js";
import { SESSION_COOKIE, sha256Hex, type DashboardRequest } from "../dashboard-http.js";
import { drizzleBootstrapStore } from "../bootstrap-store.js";
import { drizzleDashboardStore } from "../dashboard-store.js";
import { viewFeedbackReport } from "./dashboard-setup.js";

/**
 * The compose dashboard's database login (NIC-1056) on real Postgres: every request the
 * dashboard makes works as that login, and what it mustn't do is refused. Set
 * LGTMOOSE_TEST_DATABASE_URL as for packages/db's integration tests (which fail in CI without
 * it); unset, as in CI's compose job, this is skipped.
 */
const adminUrl = process.env.LGTMOOSE_TEST_DATABASE_URL;

/** The teardown's forced drop terminates open connections (57P01): expected, ignored. */
function onError(error: Error & { code?: string }): void {
  if (error.code === "57P01") return;
  throw error;
}

const ORIGIN = "https://dashboard.test";

describe.skipIf(adminUrl === undefined)("the dashboard's database login", () => {
  const database = `lgtmoose_dashboard_${randomBytes(4).toString("hex")}`;
  const role = `lgtmoose_dashboard_test_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  let owner: pg.Pool;
  let dashboard: pg.Pool;
  let deps: DashboardDeps;
  let learningId: string;
  const token = randomBytes(32).toString("base64url");

  const url = (user?: { name: string; password: string }) => {
    const parsed = new URL(adminUrl ?? "");
    parsed.pathname = `/${database}`;
    if (user !== undefined) {
      parsed.username = user.name;
      parsed.password = user.password;
    }
    return parsed.toString();
  };

  const request = (method: string, path: string, query: Record<string, string> = {}) =>
    ({
      method,
      path,
      query,
      headers: method === "GET" ? {} : { origin: ORIGIN, "sec-fetch-site": "same-origin" },
      cookies: { [SESSION_COOKIE]: token },
    }) satisfies DashboardRequest;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    admin.on("error", onError);
    await admin.connect();
    try {
      await admin.query(`create database ${database}`);
    } finally {
      await admin.end();
    }
    await runMigrations({ connectionString: url(), migrationsFolder: MIGRATIONS_FOLDER });
    owner = new pg.Pool({ connectionString: url(), max: 4 });
    owner.on("error", onError);
    const client = await owner.connect();
    try {
      await ensureDashboardRole(client, password, { reportKey: FEEDBACK_REPORT_KEY, role });
      // Again, as every runner start does.
      await ensureDashboardRole(client, password, { reportKey: FEEDBACK_REPORT_KEY, role });
    } finally {
      client.release();
    }

    // What the runner has written, as the owner.
    const db = drizzle({ client: owner });
    const [pr] = await db
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "acme/shop",
        number: 7,
        author: "dev",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
      })
      .returning({ id: pullRequests.id });
    if (pr === undefined) throw new Error("no pull request");
    await db.insert(findings).values({
      pullRequestId: pr.id,
      fingerprint: "f1",
      ruleCategory: "correctness",
      severity: "blocking",
      path: "src/a.ts",
      line: 3,
      title: "Off by one",
      body: "The loop skips the last item.",
      raisedAtSha: "a".repeat(40),
      status: "open",
    });
    const [run] = await db
      .insert(reviewRuns)
      .values({ pullRequestId: pr.id, headSha: "a".repeat(40), kind: "first", status: "succeeded" })
      .returning({ id: reviewRuns.id });
    if (run === undefined) throw new Error("no run");
    await db
      .insert(providerUsage)
      .values({ runId: run.id, providerId: "claude", role: "reviewer" });
    await db.insert(providerCooldowns).values({
      providerId: "codex",
      until: new Date(Date.now() + 3_600_000),
      reason: "limit",
    });
    const { learning } = await drizzleLearningStore(db).insert(
      {
        org: "acme",
        repo: "acme/shop",
        pathGlob: undefined,
        kind: "convention",
        category: undefined,
        text: "Amounts are in cents.",
        status: "pending",
        sourceRepo: "acme/shop",
        sourcePr: 7,
        sourceCommentId: 1,
        author: "dana",
        authorPermission: "read",
      },
      [{ type: "proposed", actor: "dana", actorPermission: "read", githubCommentId: 1 }],
    );
    learningId = learning.id;
    const artifacts = postgresArtifactStore(db);
    await artifacts.putText(
      FEEDBACK_REPORT_KEY,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        windowDays: 30,
        threshold: 0.5,
        minSamples: 5,
        categories: [],
        declined: [],
      }),
    );
    await artifacts.putText("runs/r1/transcripts/claude.jsonl", "a transcript");

    dashboard = new pg.Pool({ connectionString: url({ name: role, password }), max: 4 });
    dashboard.on("error", onError);
    const dashboardDb = drizzle({ client: dashboard });
    deps = {
      store: drizzleDashboardStore(dashboardDb),
      learnings: drizzleLearningStore(dashboardDb),
      bootstraps: { store: drizzleBootstrapStore(dashboardDb), maxPrs: 200 },
      feedbackReport: viewFeedbackReport(dashboard),
      github: {} as DashboardDeps["github"],
      oauthClient: async () => undefined,
      signingKey: async () => Buffer.alloc(32, 1),
      origin: async () => ORIGIN,
      allowedOrgs: ["acme"],
      now: () => new Date(),
      log: () => undefined,
    };
  }, 60_000);

  afterAll(async () => {
    await dashboard?.end();
    if (owner !== undefined) {
      await owner.query(`drop owned by ${role}`).catch(() => undefined);
      await owner.query(`drop role if exists ${role}`).catch(() => undefined);
      await owner.end();
    }
    const admin = new pg.Client({ connectionString: adminUrl });
    admin.on("error", onError);
    await admin.connect();
    try {
      await admin.query(`drop database if exists ${database} with (force)`);
      // Roles are cluster-wide: drop it here too, in case the owner pool couldn't.
      await admin.query(`drop role if exists ${role}`).catch(() => undefined);
    } finally {
      await admin.end();
    }
  });

  it("does all the dashboard does", async () => {
    // Signing in stores the session.
    await deps.store.createSession(sha256Hex(token), {
      login: "dev",
      orgs: ["acme"],
      repos: ["acme/shop"],
      writeRepos: ["acme/shop"],
      ownerOrgs: [],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await deps.store.deleteExpired(new Date());

    const get = async (path: string, query?: Record<string, string>) => {
      const response = await handleDashboardRequest(deps, request("GET", path, query));
      expect(response.status, path).toBe(200);
      return JSON.parse(response.body) as Record<string, unknown>;
    };
    expect(await get("/api/me")).toMatchObject({ login: "dev" });
    expect(await get("/api/repos")).toMatchObject({
      repos: [{ repo: "acme/shop", openFindings: 1, blocking: 1 }],
    });
    const listed = await get("/api/findings", { repo: "acme/shop" });
    expect(listed).toMatchObject({ findings: [{ title: "Off by one" }] });
    // Answering a finding (NIC-1140) through its column grants.
    const findingId = (listed.findings as { id: string }[])[0]?.id ?? "";
    const answered = await handleDashboardRequest(deps, {
      ...request("POST", `/api/findings/${findingId}/ack`),
      body: JSON.stringify({ outcome: "fixed" }),
    });
    expect(answered.status).toBe(200);
    const claims = await owner.query<{ fix_claimed_by: string; type: string }>(
      `select f.fix_claimed_by, e.type from findings f
         join finding_events e on e.finding_id = f.id where f.id = $1`,
      [findingId],
    );
    expect(claims.rows).toEqual([{ fix_claimed_by: "dev", type: "fix_claimed" }]);
    expect(await get("/api/runs")).toMatchObject({ runs: [{ status: "succeeded" }] });
    expect(await get("/api/usage")).toMatchObject({
      providers: [{ providerId: "claude" }],
      cooldowns: [{ providerId: "codex" }],
      // The spend ledger (NIC-1079), read as the dashboard's login.
      spend: { repos: [] },
    });
    expect(await get("/api/learnings")).toMatchObject({ learnings: [{ id: learningId }] });
    // What was learned lately, and what wasn't followed (NIC-1081): `learning_events` read
    // through its column grant.
    expect(await get("/api/learnings/activity")).toMatchObject({
      days: 7,
      learned: [{ id: learningId }],
      notFollowed: [],
    });
    // The report, through its view.
    expect(await get("/api/acceptance")).toMatchObject({ report: { version: 1 } });
    // Asking for a bootstrap from review history (NIC-1080), and seeing it.
    const asked = await handleDashboardRequest(
      deps,
      request("POST", "/api/bootstraps", { repo: "acme/shop" }),
    );
    expect(asked.status).toBe(202);
    expect(await get("/api/bootstraps")).toMatchObject({
      bootstraps: [{ repo: "acme/shop", status: "requested", requestedBy: "dev" }],
      items: [],
    });

    // Approving goes through the policy, as the signed-in person.
    const approved = await handleDashboardRequest(
      deps,
      request("POST", `/api/learnings/${learningId}/approve`),
    );
    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.body)).toMatchObject({
      outcome: "done",
      learning: { status: "active" },
    });
    const events = await owner.query<{ type: string; actor: string }>(
      "select type, actor from learning_events where learning_id = $1 order by seq",
      [learningId],
    );
    expect(events.rows).toEqual([
      { type: "proposed", actor: "dana" },
      { type: "approved", actor: "dev" },
    ]);
    const rejected = await handleDashboardRequest(
      deps,
      request("POST", `/api/learnings/${learningId}/reject`),
    );
    expect(JSON.parse(rejected.body)).toMatchObject({ learning: { status: "retired" } });

    // Signing out deletes the session.
    const out = await handleDashboardRequest(deps, request("POST", "/api/auth/logout"));
    expect(out.status).toBe(204);
    expect(await deps.store.session(sha256Hex(token), new Date())).toBeUndefined();
  }, 30_000);

  it("is refused everything else", async () => {
    for (const statement of [
      // Other artifacts: transcripts, run data, credential leases.
      "select * from artifacts",
      "select key from artifacts",
      "insert into artifacts (key, body, etag) values ('k', 'x', 'e')",
      // The runner's tables.
      "select * from job_queue",
      "insert into job_queue (queue, group_id, dedupe_id, body) values ('jobs', 'g', 'd', '{}')",
      "select * from local_executions",
      "select * from local_runners",
      "select * from dispatched_executions",
      "select * from feedback",
      // Writes it doesn't make.
      "update learnings set text = 'something else'",
      "update learnings set status = 'active', author = 'mallory'",
      `insert into learnings (org, kind, text, status, author, author_permission) values ('acme', 'convention', 'x', 'active', 'm', 'write')`,
      "delete from learnings",
      // Only which learning, what happened and when: not who.
      "select actor from learning_events",
      "update learning_events set actor = 'mallory'",
      "delete from learning_events",
      // An answer to a finding (NIC-1140) changes its status and fix claim, nothing else.
      "update findings set title = 'something else'",
      "update findings set severity = 'nit'",
      "update findings set github_comment_id = 1",
      "delete from findings",
      "select * from finding_events",
      "update finding_events set actor_login = 'mallory'",
      "delete from finding_events",
      "update review_runs set status = 'failed'",
      "update spend_ledger set settled = true",
      "delete from spend_ledger",
      "update review_runs set spend_cap = null",
      "update dashboard_sessions set login = 'mallory'",
      "update dashboard_sessions set repos = '[\"other/repo\"]'",
      // A bootstrap, once asked for, is the runner's.
      "update learning_bootstraps set status = 'done'",
      "delete from learning_bootstraps",
      "insert into learning_bootstrap_items (learning_id, bootstrap_id, sources) values (gen_random_uuid(), gen_random_uuid(), '[]')",
      "delete from learning_bootstrap_items",
      "create table mine (id int)",
      "create or replace view dashboard_feedback_report as select key as body from artifacts",
    ]) {
      await expect(dashboard.query(statement), statement).rejects.toThrow(
        /permission denied|must be owner/,
      );
    }
  }, 30_000);
});
