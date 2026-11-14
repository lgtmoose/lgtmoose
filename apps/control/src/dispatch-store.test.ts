import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { findingEvents, findings, pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleDispatchStore } from "./dispatch-aws.js";

// The migrations create the vector extension (for learnings).
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleDispatchStore(db);
const T1 = new Date("2026-11-14T00:00:01.000Z");
const T2 = new Date("2026-11-14T00:00:02.000Z");

// PGlite starts slowly, and more slowly while turbo runs other packages alongside.
beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function run(
  number: number,
  executionArn: string,
  headSha: string,
  status: "running" | "succeeded" | "covered",
) {
  const [pull] = await db
    .insert(pullRequests)
    .values({ installationId: 1, repo: "Acme/Shop", number, author: "dev", headSha, baseSha: "b" })
    .returning({ id: pullRequests.id });
  if (pull === undefined) throw new Error("no pull request");
  const [row] = await db
    .insert(reviewRuns)
    .values({ pullRequestId: pull.id, headSha, kind: "first", status, executionArn })
    .returning({ id: reviewRuns.id });
  if (row === undefined) throw new Error("no run");
  return row.id;
}

describe("drizzleDispatchStore", () => {
  it("keeps the newest event per PR, case-insensitively, and whether it closed the PR", async () => {
    expect(await store.latest("acme/shop", 1)).toBeUndefined();
    await store.advance("Acme/Shop", 1, T1, false);
    expect(await store.latest("acme/shop", 1)).toEqual({ eventAt: T1, closed: false });
    await store.advance("acme/shop", 1, T2, true);
    expect(await store.latest("ACME/shop", 1)).toEqual({ eventAt: T2, closed: true });
    expect(await store.latest("acme/shop", 2)).toBeUndefined();
  });

  it("lists a PR's executions until they're marked stopped; recording twice is a no-op", async () => {
    const one = { executionArn: "arn:e1", headSha: "a", eventAt: T1 };
    await store.record("Acme/Shop", 3, one);
    await store.record("acme/shop", 3, { ...one, headSha: "changed" });
    await store.record("acme/shop", 4, { executionArn: "arn:e2", headSha: "b", eventAt: T2 });
    expect(await store.unstopped("acme/shop", 3)).toEqual([one]);
    await store.markStopped("arn:e1");
    expect(await store.unstopped("acme/shop", 3)).toEqual([]);
  });

  it("supersedes only an unfinished run, and knows which heads were reviewed", async () => {
    const running = await run(5, "arn:r1", "h1", "running");
    const done = await run(6, "arn:r2", "h2", "succeeded");
    await store.supersedeRun("arn:r1");
    await store.supersedeRun("arn:r2");
    await store.supersedeRun("arn:none");
    const status = async (id: string) =>
      (await db.select().from(reviewRuns).where(eq(reviewRuns.id, id)))[0]?.status;
    expect(await status(running)).toBe("superseded");
    expect(await status(done)).toBe("succeeded");
    expect(await store.reviewed("Acme/Shop", 6, "h2")).toBe(true);
    expect(await store.reviewed("Acme/Shop", 5, "h1")).toBe(false);
    expect(await store.reviewed("Acme/Shop", 6, "other")).toBe(false);
  });

  it("counts a covered run's head as reviewed: another run's review is on it", async () => {
    await run(20, "arn:c1", "h20", "covered");
    expect(await store.reviewed("Acme/Shop", 20, "h20")).toBe(true);
  });

  it("follows a person resolving and unresolving our finding's thread", async () => {
    const [pull] = await db
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "Acme/Shop",
        number: 30,
        author: "dev",
        headSha: "h",
        baseSha: "b",
      })
      .returning({ id: pullRequests.id });
    if (pull === undefined) throw new Error("no pull request");
    const finding = (fingerprint: string, commentId: number, source: "self" | "bot" = "self") => ({
      pullRequestId: pull.id,
      fingerprint,
      ruleCategory: "correctness",
      severity: "blocking" as const,
      path: "a.ts",
      line: 1,
      side: "RIGHT" as const,
      title: "t",
      body: "b",
      raisedAtSha: "h",
      source,
      githubCommentId: commentId,
    });
    const [ours] = await db
      .insert(findings)
      .values(finding("f1", 3_000_000_001))
      .returning({ id: findings.id });
    await db.insert(findings).values(finding("f2", 3_000_000_002, "bot"));
    if (ours === undefined) throw new Error("no finding");
    const status = async () =>
      (await db.select().from(findings).where(eq(findings.id, ours.id)))[0]?.status;

    expect(await store.followThread("acme/shop", 30, 3_000_000_001, true)).toBe(1);
    expect(await status()).toBe("resolved_by_human");
    // Already resolved: nothing to do.
    expect(await store.followThread("acme/shop", 30, 3_000_000_001, true)).toBe(0);
    expect(await store.followThread("acme/shop", 30, 3_000_000_001, false)).toBe(1);
    expect(await status()).toBe("open");
    // Not ours, another PR's, or no such comment: left alone.
    expect(await store.followThread("acme/shop", 30, 3_000_000_002, true)).toBe(0);
    expect(await store.followThread("acme/shop", 31, 3_000_000_001, true)).toBe(0);
    const events = await db
      .select()
      .from(findingEvents)
      .where(eq(findingEvents.findingId, ours.id));
    expect(events.map((event) => event.type).sort()).toEqual(["resolved", "unresolved"]);
    expect(events.every((event) => event.actor === "human")).toBe(true);
  });
});
