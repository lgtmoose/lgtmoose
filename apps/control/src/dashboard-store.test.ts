import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { findings, providerCooldowns, providerUsage, pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleDashboardStore } from "./dashboard-store.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleDashboardStore(db);

async function pullRequest(repo: string, number: number) {
  const [row] = await db
    .insert(pullRequests)
    .values({
      installationId: 1,
      repo,
      number,
      author: "dev",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    })
    .returning({ id: pullRequests.id });
  if (row === undefined) throw new Error("no row");
  return row.id;
}

async function finding(
  pullRequestId: string,
  fingerprint: string,
  severity: "blocking" | "should_fix" | "nit",
  status: "open" | "outdated" = "open",
) {
  await db.insert(findings).values({
    pullRequestId,
    fingerprint,
    ruleCategory: "security",
    severity,
    path: "src/a.ts",
    line: 3,
    title: `${severity} ${fingerprint}`,
    body: "<script>alert(1)</script>",
    raisedAtSha: "a".repeat(40),
    status,
  });
}

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const api = await pullRequest("Acme/API", 1);
  const secret = await pullRequest("Acme/Secret", 2);
  await finding(api, "f1", "nit");
  await finding(api, "f2", "blocking");
  await finding(api, "f3", "should_fix", "outdated");
  await finding(secret, "f4", "blocking");
  const [run] = await db
    .insert(reviewRuns)
    .values({
      pullRequestId: api,
      headSha: "a".repeat(40),
      kind: "first",
      status: "succeeded",
      costUsd: "0.1234",
    })
    .returning({ id: reviewRuns.id });
  await db.insert(reviewRuns).values({
    pullRequestId: secret,
    headSha: "c".repeat(40),
    kind: "first",
    status: "failed",
  });
  if (run === undefined) throw new Error("no run");
  await db.insert(providerUsage).values([
    {
      runId: run.id,
      providerId: "claude",
      role: "reviewer",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: "0.0500",
    },
    {
      runId: run.id,
      providerId: "claude",
      role: "reviewer",
      inputTokens: 50,
      outputTokens: 10,
      costUsd: "0.0250",
      limitHit: true,
      fellBackTo: "codex",
    },
    { runId: run.id, providerId: "codex", role: "reviewer" },
  ]);
  const [secretRun] = await db
    .select({ id: reviewRuns.id })
    .from(reviewRuns)
    .where(eq(reviewRuns.pullRequestId, secret));
  if (secretRun === undefined) throw new Error("no run");
  await db
    .insert(providerUsage)
    .values({ runId: secretRun.id, providerId: "gemini", role: "reviewer", limitHit: true });
  await db.insert(providerCooldowns).values([
    { providerId: "claude", until: new Date("2026-11-15T11:00:00Z"), reason: "plan_limit" },
    { providerId: "codex", until: new Date("2026-11-15T09:00:00Z"), reason: "rate_limit" },
  ]);
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe("drizzleDashboardStore", () => {
  it("keeps sessions by token hash until they expire, and removes expired ones", async () => {
    const now = new Date("2026-11-15T10:00:00Z");
    await store.createSession("live", {
      login: "alice",
      orgs: ["acme"],
      repos: ["acme/api", "acme/web"],
      writeRepos: ["acme/api"],
      ownerOrgs: ["acme"],
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await store.createSession("old", {
      login: "bob",
      orgs: ["acme"],
      repos: [],
      writeRepos: [],
      ownerOrgs: [],
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(await store.session("live", now)).toMatchObject({
      login: "alice",
      repos: ["acme/api", "acme/web"],
      writeRepos: ["acme/api"],
      ownerOrgs: ["acme"],
    });
    expect(await store.session("old", now)).toBeUndefined();
    expect(await store.deleteExpired(now)).toBe(1);
    await store.deleteSession("live");
    expect(await store.session("live", now)).toBeUndefined();
  });

  it("summarises only the repositories it's given, case-insensitively", async () => {
    const summaries = await store.repoSummaries(["acme/api"]);
    expect(summaries).toEqual([
      { repo: "acme/api", openFindings: 2, blocking: 1, lastRunAt: expect.any(String) },
    ]);
    expect(await store.repoSummaries([])).toEqual([]);
  });

  it("lists open findings in scope, most severe first, text as stored", async () => {
    const open = await store.openFindings(["acme/api"], 10);
    expect(open.map((row) => row.severity)).toEqual(["blocking", "nit"]);
    expect(open.every((row) => row.repo === "acme/api" && row.number === 1)).toBe(true);
    expect(open[0]?.body).toBe("<script>alert(1)</script>");
    expect(await store.openFindings([], 10)).toEqual([]);
  });

  it("lists runs in scope with their cost and providers", async () => {
    const runs = await store.recentRuns(["acme/api"], 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      repo: "acme/api",
      status: "succeeded",
      costUsd: 0.1234,
      providers: ["claude", "codex"],
    });
    expect((await store.recentRuns(["acme/secret"], 10))[0]?.providers).toEqual(["gemini"]);
  });

  it("adds up provider usage and limit hits in scope since a date", async () => {
    const since = new Date("2000-01-01T00:00:00Z");
    const use = await store.providerUse(["acme/api"], since);
    expect(use).toEqual([
      {
        providerId: "claude",
        batches: 2,
        inputTokens: 150,
        outputTokens: 30,
        costUsd: 0.075,
        limitHits: 1,
        fallbacks: 1,
      },
      {
        providerId: "codex",
        batches: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        limitHits: 0,
        fallbacks: 0,
      },
    ]);
    expect(await store.providerUse(["acme/api"], new Date("2100-01-01T00:00:00Z"))).toEqual([]);
    expect(await store.providerUse([], since)).toEqual([]);
  });

  it("lists cooldowns still in force", async () => {
    expect(await store.cooldowns(new Date("2026-11-15T10:00:00Z"))).toEqual([
      { providerId: "claude", until: "2026-11-15T11:00:00.000Z", reason: "plan_limit" },
    ]);
  });
});
