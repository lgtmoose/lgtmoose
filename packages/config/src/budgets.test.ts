import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_PRICES,
  budgetsSchema,
  effectiveCaps,
  estimateCost,
  repoBudgetsSchema,
  tierPrices,
} from "./budgets.js";
import { parseRepoConfigYaml } from "./repo.js";

const deploy = (input: unknown) => budgetsSchema.parse(input);
const repo = (input: unknown) => repoBudgetsSchema.parse(input);

describe("effectiveCaps", () => {
  it("has no caps when nothing is set", () => {
    expect(effectiveCaps(deploy({}), repo({}))).toEqual({});
  });

  it("takes the deploy config's caps", () => {
    expect(
      effectiveCaps(
        deploy({
          perPullRequest: { runsPerDay: 10, costPerDayUsd: 5 },
          perRepoMonthlyUsd: 100,
          monthlyUsd: 1000,
        }),
      ),
    ).toEqual({ runsPerPrPerDay: 10, prCostPerDayUsd: 5, repoMonthlyUsd: 100, monthlyUsd: 1000 });
  });

  it("lets a repository lower its caps, never raise them", () => {
    const caps = deploy({
      perPullRequest: { runsPerDay: 10, costPerDayUsd: 5 },
      perRepoMonthlyUsd: 100,
    });
    expect(
      effectiveCaps(
        caps,
        repo({ per_pull_request: { runs_per_day: 3, cost_per_day_usd: 50 }, monthly_usd: 500 }),
      ),
    ).toEqual({ runsPerPrPerDay: 3, prCostPerDayUsd: 5, repoMonthlyUsd: 100 });
  });

  it("lets a repository set a cap the deployment leaves unset", () => {
    expect(effectiveCaps(deploy({}), repo({ monthly_usd: 20 }))).toEqual({ repoMonthlyUsd: 20 });
  });

  it("never lets a repository set the deployment's monthly cap", () => {
    expect(() => repoBudgetsSchema.parse({ monthlyUsd: 1 })).toThrow();
    expect(effectiveCaps(deploy({ monthlyUsd: 300 }), repo({ monthly_usd: 1000 }))).toEqual({
      repoMonthlyUsd: 1000,
      monthlyUsd: 300,
    });
  });

  it("reads a repository's caps from .lgtmoose.yaml", () => {
    const config = parseRepoConfigYaml(
      "budgets:\n  per_pull_request:\n    runs_per_day: 4\n  monthly_usd: 25\n",
    );
    expect(effectiveCaps(deploy({}), config.budgets)).toEqual({
      runsPerPrPerDay: 4,
      repoMonthlyUsd: 25,
    });
  });

  it("refuses negative and fractional caps", () => {
    expect(() => deploy({ monthlyUsd: -1 })).toThrow();
    expect(() => deploy({ perPullRequest: { runsPerDay: 1.5 } })).toThrow();
    expect(() => repo({ per_pull_request: { runs_per_day: 0 } })).toThrow();
  });
});

describe("estimateCost", () => {
  const standard = DEFAULT_TIER_PRICES.standard;

  it("prices each kind of token", () => {
    expect(
      estimateCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 100_000,
        },
        standard,
      ),
    ).toBeCloseTo(3 + 1.5 + 0.3 + 0.375, 6);
  });

  it("prices by tokens even when the harness reported a cost", () => {
    expect(estimateCost({ inputTokens: 1_000_000, costUsd: 99 }, standard)).toBeCloseTo(3, 6);
  });

  it("takes a reported cost when there are no tokens", () => {
    expect(estimateCost({ costUsd: 0.42 }, standard)).toBe(0.42);
  });

  it("assumes the default tokens when nothing was reported", () => {
    expect(estimateCost(undefined, standard)).toBeCloseTo((60_000 * 3 + 6_000 * 15) / 1e6, 6);
    expect(estimateCost({}, standard)).toBeCloseTo((60_000 * 3 + 6_000 * 15) / 1e6, 6);
  });
});

describe("tierPrices", () => {
  it("keeps the defaults for fields the config leaves out", () => {
    const prices = tierPrices(deploy({ prices: { standard: { input: 1 } } }));
    expect(prices.standard).toEqual({ ...DEFAULT_TIER_PRICES.standard, input: 1 });
    expect(prices.fast).toEqual(DEFAULT_TIER_PRICES.fast);
  });
});
