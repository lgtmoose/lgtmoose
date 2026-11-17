import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { findingEvents, findings, pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleChecksWaits, drizzleDispatchStore } from "./dispatch-aws.js";
import { drizzleReconcileStore } from "./reconcile-aws.js";

// The migrations create the vector extension (for learnings).
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleDispatchStore(db);
const T1 = new Date("2026-11-14T00:00:01.000Z");
const T2 = new Date("2026-11-14T00:00:02.000Z");

/** Rows as JSON, for an order-independent comparison. */
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));

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

  async function threadPr(number: number) {
    const [pull] = await db
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "Acme/Shop",
        number,
        author: "dev",
        headSha: "h",
        baseSha: "b",
      })
      .returning({ id: pullRequests.id });
    if (pull === undefined) throw new Error("no pull request");
    const add = async (
      commentId: number,
      severity: "blocking" | "should_fix" | "nit",
      options: { source?: "self" | "bot"; ruleCategory?: string } = {},
    ) => {
      const [row] = await db
        .insert(findings)
        .values({
          pullRequestId: pull.id,
          fingerprint: `f${commentId}`,
          ruleCategory: options.ruleCategory ?? "correctness",
          severity,
          path: "a.ts",
          line: 1,
          side: "RIGHT",
          title: "t",
          body: "b",
          raisedAtSha: "h",
          source: options.source ?? "self",
          githubCommentId: commentId,
        })
        .returning({ id: findings.id });
      if (row === undefined) throw new Error("no finding");
      return row.id;
    };
    const status = async (id: string) =>
      (await db.select().from(findings).where(eq(findings.id, id)))[0]?.status;
    const events = (id: string) =>
      db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    return { add, status, events };
  }

  it("follows a should_fix finding's thread resolved by anyone, the author included", async () => {
    const { add, status, events } = await threadPr(30);
    const id = await add(3_000_000_001, "should_fix");
    await add(3_000_000_002, "should_fix", { source: "bot" });

    expect(await store.followThread("acme/shop", 30, 3_000_000_001, true, "dev")).toEqual({
      changed: 1,
      held: 0,
    });
    expect(await status(id)).toBe("resolved_by_human");
    // Already resolved: nothing to do.
    expect(await store.followThread("acme/shop", 30, 3_000_000_001, true, "dev")).toEqual({
      changed: 0,
      held: 0,
    });
    expect(await store.followThread("acme/shop", 30, 3_000_000_001, false, "dev")).toEqual({
      changed: 1,
      held: 0,
    });
    expect(await status(id)).toBe("open");
    // Not ours, another PR's: left alone.
    expect(await store.followThread("acme/shop", 30, 3_000_000_002, true, "dev")).toEqual({
      changed: 0,
      held: 0,
    });
    expect(await store.followThread("acme/shop", 31, 3_000_000_001, true, "dev")).toEqual({
      changed: 0,
      held: 0,
    });
    const recorded = await events(id);
    expect(
      recorded.map((event) => [event.type, event.actorLogin, event.counted]).sort(byJson),
    ).toEqual([
      ["resolved", "dev", true],
      ["unresolved", "dev", null],
    ]);
  });

  it("holds a blocking or protected finding's resolution: it stays open, recorded as not counted", async () => {
    const { add, status, events } = await threadPr(32);
    const blocking = await add(3_000_000_011, "blocking");
    const protectedOne = await add(3_000_000_012, "nit", { ruleCategory: "authz" });

    // The PR's author, and anyone else too: the dispatcher can't check write access, so the
    // next run's thread sync decides.
    for (const actor of ["dev", "maintainer"]) {
      expect(await store.followThread("acme/shop", 32, 3_000_000_011, true, actor)).toEqual({
        changed: 0,
        held: 1,
      });
    }
    expect(await store.followThread("acme/shop", 32, 3_000_000_012, true, "dev")).toEqual({
      changed: 0,
      held: 1,
    });
    expect(await status(blocking)).toBe("open");
    expect(await status(protectedOne)).toBe("open");
    const recorded = await events(blocking);
    expect(
      recorded.map((event) => [event.type, event.actorLogin, event.counted]).sort(byJson),
    ).toEqual([
      ["resolved", "dev", false],
      ["resolved", "maintainer", false],
    ]);
  });
});

describe("the wait for CI (NIC-1078)", () => {
  const waits = drizzleChecksWaits(db);
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  it("keeps when a head’s wait began, starts it again for a new head, and clears it", async () => {
    await store.advance("Acme/Shop", 70, T1, false);
    expect(await waits.get("acme/shop", 70)).toBeUndefined();

    expect(await waits.wait("Acme/Shop", 70, A, "pending", T1)).toBeUndefined();
    expect(await waits.wait("acme/shop", 70, A, "failed:test", T2)).toEqual({
      headSha: A,
      since: T1,
      state: "pending",
    });
    expect(await waits.get("acme/shop", 70)).toEqual({
      headSha: A,
      since: T1,
      state: "failed:test",
    });

    const T3 = new Date("2026-11-14T00:00:03.000Z");
    expect(await waits.wait("acme/shop", 70, B, "pending", T3)).toBeUndefined();
    expect(await waits.get("acme/shop", 70)).toMatchObject({ headSha: B, since: T3 });

    const reconciled = await drizzleReconcileStore(db).checksWaits?.("ACME/shop");
    expect(reconciled?.get(70)).toEqual({ headSha: B, since: T3, state: "pending" });

    await waits.clear("acme/shop", 70);
    expect(await waits.get("acme/shop", 70)).toBeUndefined();
    expect((await drizzleReconcileStore(db).checksWaits?.("acme/shop"))?.has(70)).toBe(false);
    // The dispatcher’s record itself stays.
    expect(await store.latest("acme/shop", 70)).toEqual({ eventAt: T1, closed: false });
  });

  it("finds every pull request waiting on a commit, and none after the wait is cleared", async () => {
    const other = "c".repeat(40);
    await store.advance("Acme/Shop", 70, T1, false);
    await store.advance("Acme/Shop", 71, T1, false);
    await store.advance("elsewhere/shop", 3, T1, false);
    await waits.wait("acme/shop", 71, A, "pending", T1);
    await waits.wait("ACME/shop", 70, A, "success", T2);
    await waits.wait("elsewhere/shop", 3, A, "pending", T1);
    await store.advance("acme/shop", 80, T1, false);
    await waits.wait("acme/shop", 80, other, "pending", T1);
    expect(await waits.byHead("ACME/shop", A)).toEqual([70, 71]);
    expect(await waits.byHead("acme/shop", other)).toEqual([80]);

    await waits.clear("acme/shop", 71);
    expect(await waits.byHead("acme/shop", A)).toEqual([70]);
  });
});
