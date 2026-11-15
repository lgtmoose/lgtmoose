import { z } from "zod";
import type { Tier } from "./deploy.js";

/** The model tiers, as `TIERS` in deploy.ts (not imported: deploy.ts imports this module). */
const TIERS: readonly Tier[] = ["fast", "standard", "deep"];

/**
 * Spend caps (NIC-1079): the most model time a PR, a repository and the whole deployment may use.
 * The deploy config sets them; a repository's `.lgtmoose.yaml` (read at the PR's base) can only
 * lower its own. Cost is an estimate: the tokens each batch's harness reported, priced by its
 * model tier (`prices`), the same way for API keys and subscription plans, so a cap means the
 * same whichever provider ran.
 */

/** USD per million tokens of each kind, for one model tier. */
export interface TierPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What each tier costs by default: the list prices of the Claude models the tiers map to by
 * default (Haiku, Sonnet, Opus), with cache reads at a tenth of input and cache writes at 1.25×.
 * Set `budgets.prices` for other models or negotiated prices.
 */
export const DEFAULT_TIER_PRICES: Readonly<Record<Tier, TierPrice>> = {
  fast: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  standard: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  deep: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

/**
 * Tokens assumed for a batch that reported no usage, and for estimating a batch before it runs
 * while the deployment has too little history of its own (`MIN_HISTORY_BATCHES`).
 */
export const DEFAULT_BATCH_TOKENS = { input: 60_000, output: 6_000 } as const;

const usd = z.number().min(0).max(1_000_000);
const perMillion = z.number().min(0).max(10_000);

const priceSchema = z
  .object({
    input: perMillion.optional().describe("USD per million input tokens."),
    output: perMillion.optional().describe("USD per million output tokens."),
    cacheRead: perMillion.optional().describe("USD per million cache-read tokens."),
    cacheWrite: perMillion.optional().describe("USD per million cache-write tokens."),
  })
  .strict()
  .describe("This tier's prices, in USD per million tokens.");

/** `budgets` in the deploy config. Every cap is optional: unset, nothing is capped. */
export const budgetsSchema = z
  .object({
    perPullRequest: z
      .object({
        runsPerDay: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Most review runs that call a model, per PR per UTC day."),
        costPerDayUsd: usd
          .optional()
          .describe("Most estimated model cost per PR per UTC day, in USD."),
      })
      .strict()
      .prefault({})
      .describe(
        "Caps per PR per UTC day. `@lgtmoose review` from someone with write access runs once past them.",
      ),
    perRepoMonthlyUsd: usd
      .optional()
      .describe("Most estimated model cost per repository per UTC calendar month, in USD."),
    monthlyUsd: usd
      .optional()
      .describe(
        "Most estimated model cost for the whole deployment per UTC calendar month, in USD.",
      ),
    prices: z
      .object(
        Object.fromEntries(TIERS.map((tier) => [tier, priceSchema.optional()])) as {
          [K in Tier]: z.ZodOptional<typeof priceSchema>;
        },
      )
      .strict()
      .prefault({})
      .describe(
        "USD per million tokens by model tier, for the cost estimate. Unset fields keep the defaults (Claude list prices).",
      ),
  })
  .strict()
  .prefault({})
  .describe(
    "Spend caps: the most estimated model cost per PR, per repository and per month. A repository's .lgtmoose.yaml can only lower its own. See docs/costs.md.",
  );

export type Budgets = z.output<typeof budgetsSchema>;
export type BudgetsInput = z.input<typeof budgetsSchema>;

/** `budgets` in `.lgtmoose.yaml`: lower caps for this repository only. */
export const repoBudgetsSchema = z
  .object({
    per_pull_request: z
      .object({
        runs_per_day: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Most review runs that call a model, per PR per UTC day."),
        cost_per_day_usd: usd
          .optional()
          .describe("Most estimated model cost per PR per UTC day, in USD."),
      })
      .strict()
      .prefault({})
      .describe("Caps per PR per UTC day."),
    monthly_usd: usd
      .optional()
      .describe("Most estimated model cost for this repository per UTC calendar month, in USD."),
  })
  .strict()
  .prefault({})
  .describe(
    "Spend caps for this repository. They can only lower the deployment's caps, never raise them.",
  );

export type RepoBudgets = z.output<typeof repoBudgetsSchema>;

/** The caps that apply to one PR. Undefined: no cap of that kind. */
export interface SpendCaps {
  runsPerPrPerDay?: number;
  prCostPerDayUsd?: number;
  repoMonthlyUsd?: number;
  monthlyUsd?: number;
}

function lower(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * The caps for a PR: the deploy config's, lowered by the repository's own where it sets one. A
 * repository can never raise a cap, or set the deployment's monthly one.
 */
export function effectiveCaps(deploy: Budgets, repo?: RepoBudgets): SpendCaps {
  const caps: SpendCaps = {};
  const runs = lower(deploy.perPullRequest.runsPerDay, repo?.per_pull_request.runs_per_day);
  const prCost = lower(
    deploy.perPullRequest.costPerDayUsd,
    repo?.per_pull_request.cost_per_day_usd,
  );
  const repoMonthly = lower(deploy.perRepoMonthlyUsd, repo?.monthly_usd);
  if (runs !== undefined) caps.runsPerPrPerDay = runs;
  if (prCost !== undefined) caps.prCostPerDayUsd = prCost;
  if (repoMonthly !== undefined) caps.repoMonthlyUsd = repoMonthly;
  if (deploy.monthlyUsd !== undefined) caps.monthlyUsd = deploy.monthlyUsd;
  return caps;
}

/** The price of each tier: the defaults, with the deploy config's fields over them. */
export function tierPrices(budgets: Pick<Budgets, "prices">): Record<Tier, TierPrice> {
  return Object.fromEntries(
    TIERS.map((tier) => [tier, { ...DEFAULT_TIER_PRICES[tier], ...budgets.prices[tier] }]),
  ) as Record<Tier, TierPrice>;
}

/** Token usage as a harness reports it. */
export interface TokenUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
}

/**
 * One batch's estimated cost in USD: its tokens at its tier's price. A harness that reported a
 * cost but no tokens is taken at its word; one that reported nothing is assumed to have used
 * `DEFAULT_BATCH_TOKENS`, so a provider that doesn't report usage still counts.
 */
export function estimateCost(usage: TokenUsage | undefined, price: TierPrice): number {
  const tokens =
    (usage?.inputTokens ?? 0) +
    (usage?.outputTokens ?? 0) +
    (usage?.cacheReadTokens ?? 0) +
    (usage?.cacheWriteTokens ?? 0);
  if (tokens === 0) {
    if (usage?.costUsd !== undefined) return usage.costUsd;
    return (
      (DEFAULT_BATCH_TOKENS.input * price.input + DEFAULT_BATCH_TOKENS.output * price.output) / 1e6
    );
  }
  return (
    ((usage?.inputTokens ?? 0) * price.input +
      (usage?.outputTokens ?? 0) * price.output +
      (usage?.cacheReadTokens ?? 0) * price.cacheRead +
      (usage?.cacheWriteTokens ?? 0) * price.cacheWrite) /
    1e6
  );
}
