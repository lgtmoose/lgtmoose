import {
  budgetsSchema,
  estimateCost,
  tierPrices,
  type Budgets,
  type SpendCaps,
  type Tier,
  type TierPrice,
} from "@lgtmoose/config";
import { batchOutputSchema, runKeys } from "@lgtmoose/pipeline";
import type { ArtifactStore } from "./ports.js";

/**
 * Spend caps (NIC-1079). The prepare step reads what's been spent, keeps the batches that fit
 * under every cap that applies, and reserves their estimated cost in the spend ledger in one
 * locked transaction. Batches that don't fit aren't dispatched: the review is posted incomplete,
 * with a summary saying which cap and when it resets. Post settles the run at what its batches
 * reported, and raises an alert as a monthly cap passes 50%, 80% and 100%.
 *
 * Caps are checked before any model call, never during one: a batch already running finishes.
 * Costs are estimates (see `estimateCost`), so a run can end a little past a cap, by at most the
 * difference between its estimate and what it used.
 */

export type CapKind = "pr_runs" | "pr_cost" | "repo_monthly" | "monthly";

/** What's been spent, as the ledger has it (`SpendSnapshot` in @lgtmoose/db). */
export interface SpendSnapshot {
  prDayRuns: number;
  prDayUsd: number;
  repoMonthUsd: number;
  monthUsd: number;
  averageBatchUsd: number | undefined;
}

/** The spend ledger, in the database. */
export interface SpendStore {
  snapshot(target: { repo: string; prNumber: number }, now: Date): Promise<SpendSnapshot>;
  /** Reads the snapshot and records `decide`'s reservation, under one lock. */
  reserve<
    T extends
      { costUsd: number; batches: number; dispatched?: readonly DispatchedBatch[] } | undefined,
  >(
    runId: string,
    target: { repo: string; prNumber: number },
    now: Date,
    decide: (snapshot: SpendSnapshot) => T,
  ): Promise<{ snapshot: SpendSnapshot; decision: T }>;
  settle(
    runId: string,
    costUsd: number,
  ): Promise<{ repo: string; month: string; reservedUsd: number; wasSettled: boolean } | undefined>;
  /** Reservations made before `before` that no post settled, oldest first. */
  unsettled(
    before: Date,
    limit: number,
  ): Promise<{ runId: string; costUsd: number; batches: number; dispatched: DispatchedBatch[] }[]>;
  markCapped(runId: string, kind: CapKind): Promise<void>;
  lastCapped(
    pullRequestId: string,
    headSha: string,
    exceptRunId: string,
  ): Promise<string | undefined>;
  monthTotals(
    repos: readonly string[],
    now: Date,
  ): Promise<{ monthUsd: number; repos: Map<string, number> }>;
}

/**
 * `LGTMOOSE_BUDGETS`: the deploy config's `budgets`, as JSON, set by the Workflow stack and by
 * docker compose. Unset or empty: no caps, default prices. Invalid JSON fails the task at start,
 * rather than running without the caps someone set.
 */
export function readBudgets(env: Readonly<Record<string, string | undefined>>): Budgets {
  const text = env.LGTMOOSE_BUDGETS?.trim() ?? "";
  if (text === "") return budgetsSchema.parse({});
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("LGTMOOSE_BUDGETS isn't valid JSON.");
  }
  const parsed = budgetsSchema.safeParse(value);
  if (!parsed.success) throw new Error(`LGTMOOSE_BUDGETS is invalid: ${parsed.error.message}`);
  return parsed.data;
}

/** One batch the run would dispatch, in the order it's kept. */
export interface PlannedBatch {
  index: number;
  kind: "review" | "judge" | "ticket" | "explain" | "bootstrap" | "recheck";
  tier: Tier;
}

/** The cap a run ran into, for its summary and the ledger. */
export interface ReachedCap {
  kind: CapKind;
  /** USD, for a cost cap. */
  limitUsd?: number;
  /** Runs, for `pr_runs`. */
  limitRuns?: number;
  resetsAt: Date;
}

export interface SpendPlan {
  /** Indices of the batches that run. */
  keep: Set<number>;
  dropped: PlannedBatch[];
  /** The kept batches' estimated cost: what's reserved. */
  reserveUsd: number;
  /** Set when any batch was dropped. */
  cap?: ReachedCap;
}

/** A batch's estimated cost before it runs: the deployment's average, or the tier's default. */
export function batchEstimate(
  batch: Pick<PlannedBatch, "kind" | "tier">,
  prices: Readonly<Record<Tier, TierPrice>>,
  averageBatchUsd: number | undefined,
): number {
  const fallback = estimateCost(undefined, prices[batch.tier]);
  // The average is over every kind of batch, mostly reviewer ones; the small fast-tier ones
  // (judge, explain, ticket) cost less, so they're never estimated above their own default.
  if (averageBatchUsd === undefined) return fallback;
  return batch.kind === "review" ? averageBatchUsd : Math.min(averageBatchUsd, fallback);
}

const DAY_MS = 24 * 3600 * 1000;

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS);
}

function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Which of `wanted` fit under the caps, in order, and what they're estimated to cost. With
 * `override` (a person with write access asked for the review), the per-PR caps don't apply;
 * the monthly ones always do. A batch that doesn't fit is dropped, and so is every one after it
 * of the same kind, so the review batches that run are always the plan's first, riskiest ones.
 */
export function planSpend(input: {
  caps: SpendCaps;
  snapshot: SpendSnapshot;
  override: boolean;
  wanted: readonly PlannedBatch[];
  prices: Readonly<Record<Tier, TierPrice>>;
  now: Date;
}): SpendPlan {
  const { caps, snapshot, override, wanted, prices, now } = input;
  if (wanted.length === 0) return { keep: new Set(), dropped: [], reserveUsd: 0 };
  const runsCap = override ? undefined : caps.runsPerPrPerDay;
  if (runsCap !== undefined && snapshot.prDayRuns >= runsCap) {
    return {
      keep: new Set(),
      dropped: [...wanted],
      reserveUsd: 0,
      cap: { kind: "pr_runs", limitRuns: runsCap, resetsAt: nextUtcDay(now) },
    };
  }
  const headroom: { cap: ReachedCap; left: number }[] = [];
  if (!override && caps.prCostPerDayUsd !== undefined) {
    headroom.push({
      cap: { kind: "pr_cost", limitUsd: caps.prCostPerDayUsd, resetsAt: nextUtcDay(now) },
      left: caps.prCostPerDayUsd - snapshot.prDayUsd,
    });
  }
  if (caps.repoMonthlyUsd !== undefined) {
    headroom.push({
      cap: { kind: "repo_monthly", limitUsd: caps.repoMonthlyUsd, resetsAt: nextUtcMonth(now) },
      left: caps.repoMonthlyUsd - snapshot.repoMonthUsd,
    });
  }
  if (caps.monthlyUsd !== undefined) {
    headroom.push({
      cap: { kind: "monthly", limitUsd: caps.monthlyUsd, resetsAt: nextUtcMonth(now) },
      left: caps.monthlyUsd - snapshot.monthUsd,
    });
  }
  // The tightest cap decides; on a tie, the widest scope (it can't be lifted from a PR).
  const binding = headroom.reduce<(typeof headroom)[number] | undefined>(
    (tightest, entry) => (tightest === undefined || entry.left <= tightest.left ? entry : tightest),
    undefined,
  );
  const keep = new Set<number>();
  const dropped: PlannedBatch[] = [];
  const stopped = new Set<PlannedBatch["kind"]>();
  let reserveUsd = 0;
  for (const batch of wanted) {
    const estimate = batchEstimate(batch, prices, snapshot.averageBatchUsd);
    const fits = binding === undefined || reserveUsd + estimate <= binding.left;
    // The recheck relies on the review having read every file it was to (NIC-1120): with a
    // review batch cut, it's dropped too, and nothing is reserved for it.
    const orphaned = batch.kind === "recheck" && stopped.has("review");
    if (!fits || orphaned || stopped.has(batch.kind)) {
      stopped.add(batch.kind);
      dropped.push(batch);
      continue;
    }
    keep.add(batch.index);
    reserveUsd += estimate;
  }
  return {
    keep,
    dropped,
    reserveUsd,
    ...(dropped.length > 0 && binding !== undefined ? { cap: binding.cap } : {}),
  };
}

const dollars = (usd: number) => `$${usd.toFixed(2)}`;
const day = (at: Date) => at.toISOString().slice(0, 10);

/**
 * What the summary says about a cap: which one, what didn't run, when it resets, and what can
 * lift it. Kept under the summary's 200-character bullet. Plain text; the summary escapes it.
 */
export function capReason(cap: ReachedCap, notRun: number): string {
  const what = notRun === 1 ? "1 batch wasn't run" : `${notRun} batches weren't run`;
  switch (cap.kind) {
    case "pr_runs":
      return `this PR reached its spend cap of ${cap.limitRuns ?? 0} runs a day, so ${what}. It resets ${day(cap.resetsAt)} 00:00 UTC; a review command from someone with write access runs once past it`;
    case "pr_cost":
      return `this PR reached its spend cap of ${dollars(cap.limitUsd ?? 0)} a day, so ${what}. It resets ${day(cap.resetsAt)} 00:00 UTC; a review command from someone with write access runs once past it`;
    case "repo_monthly":
      return `this repository reached its monthly spend cap of ${dollars(cap.limitUsd ?? 0)}, so ${what}. It resets ${day(cap.resetsAt)} UTC; only the deployment's config can raise it`;
    case "monthly":
      return `the deployment reached its monthly spend cap of ${dollars(cap.limitUsd ?? 0)}, so ${what}. It resets ${day(cap.resetsAt)} UTC; only the deployment's config can raise it`;
  }
}

/** The check run's title for a run a cap kept batches from. */
export const SPEND_CAP_TITLE = "Spend cap reached";

/** A dispatched batch's index and tier, to price what it reported. */
export interface DispatchedBatch {
  index: number;
  tier: string;
}

const tierOf = (tier: string): Tier => (tier === "fast" || tier === "deep" ? tier : "standard");

/**
 * What the run's dispatched batches cost, from their output objects: each one's reported usage
 * at its tier's price. A batch with no readable output (it never finished) counts at
 * `missingUsd` when given (the run's reserved estimate per batch), or else the default tokens.
 */
export async function runCost(
  store: Pick<ArtifactStore, "getText">,
  runId: string,
  batches: readonly DispatchedBatch[],
  budgets: Budgets,
  missingUsd?: number,
): Promise<number> {
  const prices = tierPrices(budgets);
  const keys = runKeys(runId);
  const costs = await Promise.all(
    batches.map(async (batch) => {
      let output;
      try {
        const text = await store.getText(keys.batchOutput(batch.index));
        const parsed =
          text === undefined ? undefined : batchOutputSchema.safeParse(JSON.parse(text));
        output = parsed?.success === true ? parsed.data : undefined;
      } catch {
        output = undefined;
      }
      if (output === undefined && missingUsd !== undefined) return missingUsd;
      return estimateCost(output?.usage, prices[tierOf(batch.tier)]);
    }),
  );
  return costs.reduce((sum, cost) => sum + cost, 0);
}

/** The thresholds that alert, as a share of a monthly cap. */
export const ALERT_THRESHOLDS = [0.5, 0.8, 1] as const;

/** The thresholds a total passed going from `before` to `after` of `cap`. */
export function crossed(before: number, after: number, cap: number): number[] {
  if (cap <= 0) return after > before ? [1] : [];
  return ALERT_THRESHOLDS.filter((share) => before < share * cap && after >= share * cap);
}

/**
 * After a run is settled: the `BudgetUsed` metric (percent of the deployment's monthly cap, in
 * CloudWatch's embedded metric format, which the Workflow stack alarms on at 50, 80 and 100),
 * and a log line for each monthly cap, the deployment's or the repository's, that the run took
 * past 50%, 80% or 100%. No cost is logged with anything secret: only totals, caps and the repo.
 */
export async function spendAlerts(
  spend: Pick<SpendStore, "monthTotals">,
  settled: { repo: string; addedUsd: number },
  caps: Pick<SpendCaps, "monthlyUsd" | "repoMonthlyUsd">,
  now: Date,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  if (caps.monthlyUsd === undefined && caps.repoMonthlyUsd === undefined) return;
  const totals = await spend.monthTotals([settled.repo], now);
  const repoUsd = totals.repos.get(settled.repo.toLowerCase()) ?? 0;
  const checks: { scope: string; total: number; cap: number }[] = [];
  if (caps.monthlyUsd !== undefined) {
    checks.push({ scope: "deployment", total: totals.monthUsd, cap: caps.monthlyUsd });
    log("spend", {
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: "LGTMoose",
            Dimensions: [[]],
            Metrics: [{ Name: "BudgetUsed", Unit: "Percent" }],
          },
        ],
      },
      BudgetUsed: caps.monthlyUsd > 0 ? (100 * totals.monthUsd) / caps.monthlyUsd : 100,
    });
  }
  if (caps.repoMonthlyUsd !== undefined) {
    checks.push({ scope: `repo ${settled.repo}`, total: repoUsd, cap: caps.repoMonthlyUsd });
  }
  for (const check of checks) {
    for (const share of crossed(check.total - settled.addedUsd, check.total, check.cap)) {
      log("spend cap alert", {
        scope: check.scope,
        percent: Math.round(share * 100),
        spentUsd: Number(check.total.toFixed(2)),
        capUsd: check.cap,
      });
    }
  }
}

/** Permissions that may lift a PR's caps with a review command. */
const LIFTS_PR_CAPS: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/**
 * Whether this run may go past the PR's own caps: a review someone asked for with a command,
 * when GitHub says that person has write access now. The job only names who asked; their access
 * is never taken from it. Each command lifts them for its one run. Monthly caps always apply.
 */
export async function liftsPrCaps(
  job: { requested?: string | undefined; actor?: string | undefined },
  permission: ((login: string) => Promise<string>) | undefined,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<boolean> {
  if (job.requested !== "review" && job.requested !== "full_review") return false;
  if (job.actor === undefined || permission === undefined) return false;
  try {
    return LIFTS_PR_CAPS.has(await permission(job.actor));
  } catch (error) {
    log("permission unread, PR spend caps stay", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Whether a run that a cap stops entirely should post nothing: a run for replies or an explain
 * (it would only replace the PR's review with a capped one), or one whose head's latest posted
 * run was stopped by the same cap (it was said already). A push or a person's review command
 * on a new head still posts, so the PR says why it wasn't reviewed.
 */
export async function quietlyCapped(
  spend: Pick<SpendStore, "lastCapped">,
  run: { runId: string; pullRequestId: string },
  requested: string | undefined,
  headSha: string,
  cap: ReachedCap,
): Promise<boolean> {
  if (requested === "replies" || requested === "explain") return true;
  return (await spend.lastCapped(run.pullRequestId, headSha, run.runId)) === cap.kind;
}

/** What prepare does about spend: which batches run, and the cap that stopped the rest. */
export interface SpendDecision {
  /** Whether batch `index` runs. */
  runs(index: number): boolean;
  /** Set when a cap kept any batch from running. */
  cap?: ReachedCap;
}

/** Every batch runs: no ledger, or nothing to dispatch. */
export const RUN_ALL: SpendDecision = { runs: () => true };

/**
 * The caps check for a run about to dispatch `wanted`: reads the ledger, plans which batches fit
 * and reserves their estimate, under the ledger's lock.
 */
export async function reserveSpend(
  spend: { store: SpendStore; budgets: Budgets },
  run: { runId: string; repo: string; prNumber: number },
  input: { caps: SpendCaps; override: boolean; wanted: readonly PlannedBatch[]; now: Date },
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<SpendDecision> {
  if (input.wanted.length === 0) return RUN_ALL;
  const prices = tierPrices(spend.budgets);
  const { decision } = await spend.store.reserve(
    run.runId,
    { repo: run.repo, prNumber: run.prNumber },
    input.now,
    (snapshot) => {
      const plan = planSpend({ ...input, snapshot, prices });
      return {
        costUsd: plan.reserveUsd,
        batches: plan.keep.size,
        dispatched: input.wanted
          .filter((batch) => plan.keep.has(batch.index))
          .map((batch) => ({ index: batch.index, tier: batch.tier })),
        plan,
      };
    },
  );
  const { plan } = decision;
  log("spend reserved", {
    runId: run.runId,
    estimateUsd: Number(plan.reserveUsd.toFixed(4)),
    batches: plan.keep.size,
    ...(plan.cap === undefined ? {} : { cap: plan.cap.kind, notRun: plan.dropped.length }),
    ...(input.override ? { prCapsLifted: true } : {}),
  });
  return {
    runs: (index) => plan.keep.has(index),
    ...(plan.cap === undefined ? {} : { cap: plan.cap }),
  };
}

/** How many stale reservations one reconcile settles. */
export const SETTLE_BATCH = 50;

/**
 * Settles reservations the post step never did (NIC-1079): runs a newer push stopped, and runs
 * that failed after their batches ran. Each is priced from its batches' outputs as post would,
 * with a batch that left no output kept at the run's estimate, so the ledger comes to what was
 * spent. Until then a reservation counts at its estimate. Runs from the reconciler; a failure
 * is logged, never thrown, and the rest wait for the next run. Returns how many it settled.
 */
export async function settleStaleSpend(
  spend: { store: Pick<SpendStore, "unsettled" | "settle">; budgets: Budgets },
  artifacts: Pick<ArtifactStore, "getText">,
  now: Date,
  log: (message: string, fields?: Record<string, unknown>) => void,
  staleMs: number,
): Promise<number> {
  let settled = 0;
  try {
    const stale = await spend.store.unsettled(new Date(now.getTime() - staleMs), SETTLE_BATCH);
    for (const run of stale) {
      try {
        const perBatch = run.batches > 0 ? run.costUsd / run.batches : 0;
        const costUsd =
          run.dispatched.length === 0
            ? run.costUsd
            : await runCost(artifacts, run.runId, run.dispatched, spend.budgets, perBatch);
        await spend.store.settle(run.runId, costUsd);
        settled += 1;
        log("spend settled without a post", {
          runId: run.runId,
          costUsd: Number(costUsd.toFixed(4)),
          estimateUsd: Number(run.costUsd.toFixed(4)),
        });
      } catch (error) {
        log("stale spend not settled", {
          runId: run.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    log("stale spend not read", { error: error instanceof Error ? error.message : String(error) });
  }
  return settled;
}
