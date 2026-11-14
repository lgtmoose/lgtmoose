import { and, gt, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { providerCooldowns, providerUsage } from "./schema.js";

/** Any Drizzle Postgres database: node-postgres in the tasks, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * One provider attempt from a fallback chain, as `@lgtmoose/harness`'s `ProviderAttempt` gives
 * it. Declared here by shape so the database package doesn't depend on the harness.
 */
export interface ProviderUsageAttempt {
  providerId: string;
  tier: string;
  model: string | undefined;
  outcome: "ok" | "rate_limit" | "plan_limit" | "auth" | "cooling_down" | "failed";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  };
  cooledUntil?: Date;
  error?: string;
}

export type ProviderUsageRow = typeof providerUsage.$inferInsert;

const LIMIT_OUTCOMES: ReadonlySet<string> = new Set(["rate_limit", "plan_limit", "auth"]);
/** Longest error text kept in `details`: enough to see the reason, never a whole transcript. */
const ERROR_LIMIT = 500;

/**
 * The `provider_usage` rows for one role's run through a fallback chain: one per attempt, in
 * order. A limit hit or a cooldown skip records the provider the run moved on to as
 * `fell_back_to`. Tokens and cost come from the harness's usage report, where it gave one.
 */
export function providerUsageRows(
  runId: string,
  role: string,
  attempts: readonly ProviderUsageAttempt[],
): ProviderUsageRow[] {
  return attempts.map((attempt, i) => {
    const next = attempts[i + 1];
    const movedOn = attempt.outcome !== "ok" && attempt.outcome !== "failed";
    const usage = attempt.usage;
    return {
      runId,
      providerId: attempt.providerId,
      role,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      costUsd: usage?.costUsd === undefined ? null : usage.costUsd.toFixed(4),
      limitHit: LIMIT_OUTCOMES.has(attempt.outcome),
      fellBackTo: movedOn && next !== undefined ? next.providerId : null,
      details: {
        outcome: attempt.outcome,
        tier: attempt.tier,
        ...(attempt.model === undefined ? {} : { model: attempt.model }),
        ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage?.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: usage.cacheWriteTokens }),
        ...(attempt.cooledUntil === undefined
          ? {}
          : { cooledUntil: attempt.cooledUntil.toISOString() }),
        ...(attempt.error === undefined ? {} : { error: attempt.error.slice(0, ERROR_LIMIT) }),
      },
    };
  });
}

/** Writes usage rows. No rows, no query. */
export async function insertProviderUsage(
  db: Database,
  rows: readonly ProviderUsageRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(providerUsage).values([...rows]);
}

/**
 * Provider cooldowns in Postgres, shared by every run and task. It has the shape of
 * `@lgtmoose/harness`'s `CooldownStore`, so a `FallbackHarness` can use it directly.
 */
export class DbCooldownStore {
  constructor(private readonly db: Database) {}

  async cooledUntil(providerIds: readonly string[], now: Date): Promise<Map<string, Date>> {
    if (providerIds.length === 0) return new Map();
    const rows = await this.db
      .select({ providerId: providerCooldowns.providerId, until: providerCooldowns.until })
      .from(providerCooldowns)
      .where(
        and(
          inArray(providerCooldowns.providerId, [...providerIds]),
          gt(providerCooldowns.until, now),
        ),
      );
    return new Map(rows.map((row) => [row.providerId, row.until]));
  }

  /** Stores the cooldown, keeping a later one that's already there (and its reason). */
  async coolDown(providerId: string, until: Date, reason: string): Promise<void> {
    await this.db
      .insert(providerCooldowns)
      .values({ providerId, until, reason })
      .onConflictDoUpdate({
        target: providerCooldowns.providerId,
        set: {
          until: sql`greatest(${providerCooldowns.until}, excluded.until)`,
          reason: sql`case when excluded.until > ${providerCooldowns.until} then excluded.reason else ${providerCooldowns.reason} end`,
          updatedAt: sql`now()`,
        },
      });
  }
}
