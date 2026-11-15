import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrate.js";
import { pullRequests, reviewRuns, spendLedger } from "./schema.js";
import { MIN_HISTORY_BATCHES, STALE_RESERVATION_MS, postgresSpend, spendPeriod } from "./spend.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const spend = postgresSpend(db);
const NOW = new Date("2026-11-15T13:00:00Z");

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

/** A PR and a run of it, for the ledger's foreign key. */
async function newRun(repo: string, number: number, headSha = "a".repeat(40)) {
  const [pull] = await db
    .insert(pullRequests)
    .values({ installationId: 1, repo, number, author: "dana", headSha, baseSha: "b".repeat(40) })
    .onConflictDoUpdate({
      target: [pullRequests.repo, pullRequests.number],
      set: { headSha },
    })
    .returning({ id: pullRequests.id });
  const [run] = await db
    .insert(reviewRuns)
    .values({ pullRequestId: pull?.id ?? "", headSha, kind: "first", status: "running" })
    .returning({ id: reviewRuns.id });
  return { runId: run?.id ?? "", pullRequestId: pull?.id ?? "" };
}

describe("spendPeriod", () => {
  it("is the UTC month and day", () => {
    expect(spendPeriod(new Date("2026-11-30T23:59:59Z"))).toEqual({
      month: "2026-11",
      day: "2026-11-30",
    });
    expect(spendPeriod(new Date("2026-12-01T00:00:00Z"))).toEqual({
      month: "2026-12",
      day: "2026-12-01",
    });
  });
});

describe("postgresSpend", () => {
  it("reserves, then counts the reservation for the PR, its repo and the month", async () => {
    const target = { repo: "Acme/Web", prNumber: 1 };
    const { runId } = await newRun("acme/web", 1);
    const { snapshot } = await spend.reserve(runId, target, NOW, (seen) => {
      expect(seen.prDayRuns).toBe(0);
      return { costUsd: 1.25, batches: 3 };
    });
    expect(snapshot.monthUsd).toBe(0);
    const after = await spend.snapshot({ repo: "acme/web", prNumber: 1 }, NOW);
    expect(after).toMatchObject({
      prDayRuns: 1,
      prDayUsd: 1.25,
      repoMonthUsd: 1.25,
      monthUsd: 1.25,
    });
    // Another PR in the repo: the repo and month count it, the PR's day doesn't.
    expect(await spend.snapshot({ repo: "acme/web", prNumber: 2 }, NOW)).toMatchObject({
      prDayRuns: 0,
      prDayUsd: 0,
      repoMonthUsd: 1.25,
    });
  });

  it("records nothing when the decision dispatches no batch, and a run once", async () => {
    const target = { repo: "acme/none", prNumber: 9 };
    const { runId } = await newRun("acme/none", 9);
    await spend.reserve(runId, target, NOW, () => ({ costUsd: 0, batches: 0 }));
    await spend.reserve(runId, target, NOW, () => undefined);
    expect((await spend.snapshot(target, NOW)).prDayRuns).toBe(0);
    await spend.reserve(runId, target, NOW, () => ({ costUsd: 2, batches: 1 }));
    await spend.reserve(runId, target, NOW, () => ({ costUsd: 5, batches: 1 }));
    expect(await spend.snapshot(target, NOW)).toMatchObject({ prDayRuns: 1, prDayUsd: 2 });
  });

  it("settles at the reported cost, and settling again writes the same", async () => {
    const target = { repo: "acme/settle", prNumber: 3 };
    const { runId } = await newRun("acme/settle", 3);
    await spend.reserve(runId, target, NOW, () => ({ costUsd: 1, batches: 2 }));
    expect(await spend.settle(runId, 0.4)).toEqual({
      repo: "acme/settle",
      month: "2026-11",
      reservedUsd: 1,
      wasSettled: false,
    });
    expect(await spend.settle(runId, 0.4)).toMatchObject({ reservedUsd: 0.4, wasSettled: true });
    expect((await spend.snapshot(target, NOW)).repoMonthUsd).toBeCloseTo(0.4);
    expect(await spend.settle("00000000-0000-4000-8000-000000000000", 1)).toBeUndefined();
  });

  it("counts a reservation post never settled, however old, until it's settled", async () => {
    const target = { repo: "acme/stale", prNumber: 4 };
    const stopped = await newRun("acme/stale", 4);
    const posted = await newRun("acme/stale", 4);
    await spend.reserve(stopped.runId, target, NOW, () => ({
      costUsd: 3,
      batches: 2,
      dispatched: [
        { index: 0, tier: "standard" },
        { index: 1, tier: "fast" },
      ],
    }));
    await spend.reserve(posted.runId, target, NOW, () => ({ costUsd: 1, batches: 1 }));
    await spend.settle(posted.runId, 1);
    // A day and more on, as a run a newer push stopped would be: it still counts.
    await db
      .update(spendLedger)
      .set({ createdAt: new Date(NOW.getTime() - 30 * 3600 * 1000) })
      .where(sql`${spendLedger.repo} = 'acme/stale'`);
    expect((await spend.snapshot(target, NOW)).repoMonthUsd).toBe(4);
    expect((await spend.monthTotals(["acme/stale"], NOW)).repos.get("acme/stale")).toBe(4);

    // Listed for the reconciler, with what it dispatched; the settled one isn't.
    const stale = await spend.unsettled(new Date(NOW.getTime() - STALE_RESERVATION_MS), 50);
    const mine = stale.filter((row) => row.runId === stopped.runId || row.runId === posted.runId);
    expect(mine).toEqual([
      {
        runId: stopped.runId,
        costUsd: 3,
        batches: 2,
        dispatched: [
          { index: 0, tier: "standard" },
          { index: 1, tier: "fast" },
        ],
      },
    ]);
    // Settled at what it really cost, the totals follow, and it's listed no more.
    await spend.settle(stopped.runId, 1.75);
    expect((await spend.snapshot(target, NOW)).repoMonthUsd).toBeCloseTo(2.75);
    expect((await spend.unsettled(NOW, 50)).some((row) => row.runId === stopped.runId)).toBe(false);
  });

  it("lists only reservations older than the cut-off, oldest first", async () => {
    const target = { repo: "acme/young", prNumber: 6 };
    const young = await newRun("acme/young", 6);
    await spend.reserve(young.runId, target, NOW, () => ({ costUsd: 1, batches: 1 }));
    const cutoff = new Date(Date.now() - STALE_RESERVATION_MS);
    expect((await spend.unsettled(cutoff, 50)).some((row) => row.runId === young.runId)).toBe(
      false,
    );
    expect((await spend.unsettled(new Date(Date.now() + 60_000), 1)).length).toBe(1);
  });

  // Its own database, so other tests' settled runs don't count: PGlite starts slowly, more so
  // while turbo runs other packages alongside.
  it("averages settled batches once there are enough of them", async () => {
    const fresh = drizzle(new PGlite({ extensions: { vector } }));
    await migrate(fresh, { migrationsFolder: MIGRATIONS_FOLDER });
    const own = postgresSpend(fresh);
    const [pull] = await fresh
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "acme/avg",
        number: 1,
        author: "dana",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
      })
      .returning({ id: pullRequests.id });
    const runOf = async () => {
      const [run] = await fresh
        .insert(reviewRuns)
        .values({ pullRequestId: pull?.id ?? "", headSha: "a".repeat(40), kind: "first" })
        .returning({ id: reviewRuns.id });
      return run?.id ?? "";
    };
    const target = { repo: "acme/avg", prNumber: 1 };
    const first = await runOf();
    await own.reserve(first, target, new Date(), () => ({
      costUsd: 1,
      batches: MIN_HISTORY_BATCHES - 1,
    }));
    await own.settle(first, 4.5);
    expect((await own.snapshot(target, new Date())).averageBatchUsd).toBeUndefined();
    const second = await runOf();
    await own.reserve(second, target, new Date(), () => ({ costUsd: 1, batches: 1 }));
    await own.settle(second, 0.5);
    expect((await own.snapshot(target, new Date())).averageBatchUsd).toBeCloseTo(5 / 10);
  }, 60_000);

  it("marks a capped run and finds it as the head's latest posted run", async () => {
    const sha = "c".repeat(40);
    const older = await newRun("acme/capped", 5, sha);
    const newer = await newRun("acme/capped", 5, sha);
    await spend.markCapped(older.runId, "monthly");
    await db.update(reviewRuns).set({ status: "succeeded" }).where(eq(reviewRuns.id, older.runId));
    expect(await spend.lastCapped(older.pullRequestId, sha, newer.runId)).toBe("monthly");
    // Not itself, and not at another head.
    expect(await spend.lastCapped(older.pullRequestId, sha, older.runId)).toBeUndefined();
    expect(
      await spend.lastCapped(older.pullRequestId, "d".repeat(40), newer.runId),
    ).toBeUndefined();
    // A newer posted run that wasn't capped is the latest.
    await db.update(reviewRuns).set({ status: "succeeded" }).where(eq(reviewRuns.id, newer.runId));
    const third = await newRun("acme/capped", 5, sha);
    expect(await spend.lastCapped(older.pullRequestId, sha, third.runId)).toBeUndefined();
  });

  it("totals the month for the deployment and the repositories asked about", async () => {
    const totals = await spend.monthTotals(["ACME/WEB", "acme/nothing"], NOW);
    expect(totals.repos.get("acme/web")).toBe(1.25);
    expect(totals.repos.has("acme/nothing")).toBe(false);
    expect(totals.monthUsd).toBeGreaterThan(1.25);
    expect((await spend.monthTotals([], NOW)).repos.size).toBe(0);
  });
});
