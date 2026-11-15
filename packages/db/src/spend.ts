import { and, desc, eq, gt, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { reviewRuns, spendLedger } from "./schema.js";
import type { Database } from "./usage.js";

/**
 * The spend ledger (NIC-1079): one row per review run that dispatched batches, reserved at its
 * estimate before they run and settled at what they reported after. Caps are checked and a
 * reservation made under one transaction-scoped advisory lock, so two runs prepared at once
 * can't both see the same headroom: the second sees the first's reservation.
 */

/** How long an unsettled reservation counts: longer than any run can take. */
export const RESERVATION_TTL_MS = 24 * 3600 * 1000;
/** How far back the average batch cost is taken from. */
const HISTORY_MS = 30 * 24 * 3600 * 1000;
/** Fewer settled batches than this, and the deployment has no average of its own yet. */
export const MIN_HISTORY_BATCHES = 10;

/** One advisory lock for every reservation: they're short, and rare next to model calls. */
const LOCK_KEY = "lgtmoose:spend";

/** UTC calendar month and day of `at`: `2026-11` and `2026-11-15`. */
export function spendPeriod(at: Date): { month: string; day: string } {
  const day = at.toISOString().slice(0, 10);
  return { month: day.slice(0, 7), day };
}

/** What's been spent where a run is about to be prepared. Costs in USD. */
export interface SpendSnapshot {
  /** The PR's runs today that dispatched batches, reserved or settled. */
  prDayRuns: number;
  prDayUsd: number;
  repoMonthUsd: number;
  monthUsd: number;
  /** The deployment's average settled cost per batch over 30 days, once it has enough. */
  averageBatchUsd: number | undefined;
}

export interface SpendTarget {
  /** owner/name; compared in lower case. */
  repo: string;
  prNumber: number;
}

/** A run's reservation, from the decision made on a snapshot. */
export interface SpendReservation {
  costUsd: number;
  batches: number;
}

const money = (value: unknown) => Number(value ?? 0);

/** Rows that count: settled ones, and reservations young enough to still be running. */
function counting(now: Date): SQL {
  return or(
    eq(spendLedger.settled, true),
    gt(spendLedger.createdAt, new Date(now.getTime() - RESERVATION_TTL_MS)),
  ) as SQL;
}

async function snapshotOf(db: Database, target: SpendTarget, now: Date): Promise<SpendSnapshot> {
  const repo = target.repo.toLowerCase();
  const { month, day } = spendPeriod(now);
  const live = counting(now);
  const [totals] = await db
    .select({
      monthUsd: sql<string>`coalesce(sum(${spendLedger.costUsd}), 0)`,
      repoMonthUsd: sql<string>`coalesce(sum(${spendLedger.costUsd}) filter (where ${spendLedger.repo} = ${repo}), 0)`,
      prDayUsd: sql<string>`coalesce(sum(${spendLedger.costUsd}) filter (where ${spendLedger.repo} = ${repo} and ${spendLedger.prNumber} = ${target.prNumber} and ${spendLedger.day} = ${day}), 0)`,
      prDayRuns: sql<number>`count(*) filter (where ${spendLedger.repo} = ${repo} and ${spendLedger.prNumber} = ${target.prNumber} and ${spendLedger.day} = ${day})`,
    })
    .from(spendLedger)
    .where(and(eq(spendLedger.month, month), live));
  const [history] = await db
    .select({
      cost: sql<string>`coalesce(sum(${spendLedger.costUsd}), 0)`,
      batches: sql<number>`coalesce(sum(${spendLedger.batches}), 0)`,
    })
    .from(spendLedger)
    .where(
      and(
        eq(spendLedger.settled, true),
        gt(spendLedger.createdAt, new Date(now.getTime() - HISTORY_MS)),
      ),
    );
  const batches = Number(history?.batches ?? 0);
  return {
    prDayRuns: Number(totals?.prDayRuns ?? 0),
    prDayUsd: money(totals?.prDayUsd),
    repoMonthUsd: money(totals?.repoMonthUsd),
    monthUsd: money(totals?.monthUsd),
    averageBatchUsd: batches >= MIN_HISTORY_BATCHES ? money(history?.cost) / batches : undefined,
  };
}

export function postgresSpend(db: Database) {
  return {
    /** What's spent now, without reserving: for a check before the clone. */
    snapshot: (target: SpendTarget, now: Date) => snapshotOf(db, target, now),
    /**
     * Reads what's spent and, if `decide` returns a reservation, records it for `runId`, all
     * under the spend lock: another run's reservation is either seen or waits for this one.
     * Returns the snapshot `decide` saw. A second reservation for the same run is a no-op.
     */
    async reserve<T extends SpendReservation | undefined>(
      runId: string,
      target: SpendTarget,
      now: Date,
      decide: (snapshot: SpendSnapshot) => T,
    ): Promise<{ snapshot: SpendSnapshot; decision: T }> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`);
        const snapshot = await snapshotOf(tx as unknown as Database, target, now);
        const decision = decide(snapshot);
        if (decision !== undefined && decision.batches > 0) {
          const { month, day } = spendPeriod(now);
          await tx
            .insert(spendLedger)
            .values({
              runId,
              repo: target.repo.toLowerCase(),
              prNumber: target.prNumber,
              month,
              day,
              costUsd: decision.costUsd.toFixed(4),
              batches: decision.batches,
            })
            .onConflictDoNothing({ target: spendLedger.runId });
        }
        return { snapshot, decision };
      });
    },
    /**
     * Settles a run at what its batches reported. Repeating it (a retried post) writes the same
     * cost again. Returns the run's reserved estimate and its row, or undefined without one.
     */
    async settle(
      runId: string,
      costUsd: number,
    ): Promise<
      { repo: string; month: string; reservedUsd: number; wasSettled: boolean } | undefined
    > {
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select({
            repo: spendLedger.repo,
            month: spendLedger.month,
            costUsd: spendLedger.costUsd,
            settled: spendLedger.settled,
          })
          .from(spendLedger)
          .where(eq(spendLedger.runId, runId))
          .for("update");
        if (before === undefined) return undefined;
        await tx
          .update(spendLedger)
          .set({ costUsd: costUsd.toFixed(4), settled: true, updatedAt: sql`now()` })
          .where(eq(spendLedger.runId, runId));
        return {
          repo: before.repo,
          month: before.month,
          reservedUsd: money(before.costUsd),
          wasSettled: before.settled,
        };
      });
    },
    /** Records the cap that kept batches of the run from running. */
    async markCapped(runId: string, kind: string): Promise<void> {
      await db.update(reviewRuns).set({ spendCap: kind }).where(eq(reviewRuns.id, runId));
    },
    /**
     * The cap on the PR's latest posted run at `headSha` other than `exceptRunId`, if that run
     * was capped: then a run that would be capped the same way has nothing new to say.
     */
    async lastCapped(
      pullRequestId: string,
      headSha: string,
      exceptRunId: string,
    ): Promise<string | undefined> {
      const [latest] = await db
        .select({ spendCap: reviewRuns.spendCap })
        .from(reviewRuns)
        .where(
          and(
            eq(reviewRuns.pullRequestId, pullRequestId),
            eq(reviewRuns.headSha, headSha),
            ne(reviewRuns.id, exceptRunId),
            eq(reviewRuns.status, "succeeded"),
          ),
        )
        .orderBy(desc(reviewRuns.createdAt))
        .limit(1);
      return latest?.spendCap ?? undefined;
    },
    /** This month's spend for the deployment and for each of `repos` (lower-cased keys). */
    async monthTotals(
      repos: readonly string[],
      now: Date,
    ): Promise<{ monthUsd: number; repos: Map<string, number> }> {
      const { month } = spendPeriod(now);
      const live = counting(now);
      const [all] = await db
        .select({ cost: sql<string>`coalesce(sum(${spendLedger.costUsd}), 0)` })
        .from(spendLedger)
        .where(and(eq(spendLedger.month, month), live));
      const lowered = [...new Set(repos.map((repo) => repo.toLowerCase()))];
      const rows =
        lowered.length === 0
          ? []
          : await db
              .select({
                repo: spendLedger.repo,
                cost: sql<string>`coalesce(sum(${spendLedger.costUsd}), 0)`,
              })
              .from(spendLedger)
              .where(and(eq(spendLedger.month, month), inArray(spendLedger.repo, lowered), live))
              .groupBy(spendLedger.repo);
      return {
        monthUsd: money(all?.cost),
        repos: new Map(rows.map((row) => [row.repo, money(row.cost)])),
      };
    },
  };
}

export type PostgresSpend = ReturnType<typeof postgresSpend>;
