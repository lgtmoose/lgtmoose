import { budgetsSchema, tierPrices } from "@lgtmoose/config";
import { runKeys } from "@lgtmoose/pipeline";
import { describe, expect, it, vi } from "vitest";
import {
  capReason,
  crossed,
  liftsPrCaps,
  planSpend,
  quietlyCapped,
  readBudgets,
  runCost,
  settleStaleSpend,
  spendAlerts,
  type PlannedBatch,
  type SpendSnapshot,
} from "./spend.js";

const NOW = new Date("2026-11-15T13:00:00Z");
const prices = tierPrices(budgetsSchema.parse({}));
const nothingSpent: SpendSnapshot = {
  prDayRuns: 0,
  prDayUsd: 0,
  repoMonthUsd: 0,
  monthUsd: 0,
  averageBatchUsd: 1,
};
const review = (index: number): PlannedBatch => ({ index, kind: "review", tier: "standard" });
const judge = (index: number): PlannedBatch => ({ index, kind: "judge", tier: "fast" });

describe("planSpend", () => {
  it("runs everything without caps, reserving each batch's estimate", () => {
    const plan = planSpend({
      caps: {},
      snapshot: nothingSpent,
      override: false,
      wanted: [review(0), review(1)],
      prices,
      now: NOW,
    });
    expect([...plan.keep]).toEqual([0, 1]);
    expect(plan.reserveUsd).toBe(2);
    expect(plan.cap).toBeUndefined();
  });

  it("keeps the first batches that fit under the tightest cap", () => {
    const plan = planSpend({
      caps: { prCostPerDayUsd: 10, monthlyUsd: 100 },
      snapshot: { ...nothingSpent, prDayUsd: 7.5 },
      override: false,
      wanted: [review(0), review(1), review(2), review(3)],
      prices,
      now: NOW,
    });
    expect([...plan.keep]).toEqual([0, 1]);
    expect(plan.dropped.map((batch) => batch.index)).toEqual([2, 3]);
    expect(plan.cap).toEqual({
      kind: "pr_cost",
      limitUsd: 10,
      resetsAt: new Date("2026-11-16T00:00:00Z"),
    });
  });

  it("stops a PR at its runs per day", () => {
    const plan = planSpend({
      caps: { runsPerPrPerDay: 3 },
      snapshot: { ...nothingSpent, prDayRuns: 3 },
      override: false,
      wanted: [judge(5), review(0)],
      prices,
      now: NOW,
    });
    expect(plan.keep.size).toBe(0);
    expect(plan.cap?.kind).toBe("pr_runs");
    expect(plan.reserveUsd).toBe(0);
  });

  it("lifts only the PR's caps for a review someone with write access asked for", () => {
    const input = {
      caps: { runsPerPrPerDay: 1, prCostPerDayUsd: 1, monthlyUsd: 50 },
      snapshot: { ...nothingSpent, prDayRuns: 5, prDayUsd: 30, monthUsd: 49.5 },
      wanted: [review(0)],
      prices,
      now: NOW,
    };
    expect(planSpend({ ...input, override: false }).cap?.kind).toBe("pr_runs");
    // Past the PR's caps, but the deployment's monthly cap still has $0.50: not a $1 batch.
    const lifted = planSpend({ ...input, override: true });
    expect(lifted.keep.size).toBe(0);
    expect(lifted.cap).toEqual({
      kind: "monthly",
      limitUsd: 50,
      resetsAt: new Date("2026-12-01T00:00:00Z"),
    });
    expect(
      planSpend({ ...input, snapshot: { ...input.snapshot, monthUsd: 10 }, override: true }).keep,
    ).toEqual(new Set([0]));
  });

  it("names the monthly cap when it ties with the PR's, since a PR can't lift it", () => {
    const plan = planSpend({
      caps: { prCostPerDayUsd: 5, repoMonthlyUsd: 5, monthlyUsd: 5 },
      snapshot: nothingSpent,
      override: false,
      wanted: Array.from({ length: 6 }, (_, i) => review(i)),
      prices,
      now: NOW,
    });
    expect(plan.keep.size).toBe(5);
    expect(plan.cap?.kind).toBe("monthly");
  });

  it("drops every later batch of a kind once one doesn't fit", () => {
    const plan = planSpend({
      caps: { monthlyUsd: 1.1 },
      snapshot: { ...nothingSpent, averageBatchUsd: 0.5 },
      override: false,
      // The judge's default estimate is under the average, so it fits after two reviews.
      wanted: [review(0), review(1), review(2), judge(3)],
      prices,
      now: NOW,
    });
    expect([...plan.keep].sort((a, b) => a - b)).toEqual([0, 1, 3]);
    expect(plan.dropped.map((batch) => batch.index)).toEqual([2]);
  });

  it("estimates from the tier's default tokens without history", () => {
    const plan = planSpend({
      caps: {},
      snapshot: { ...nothingSpent, averageBatchUsd: undefined },
      override: false,
      wanted: [review(0), judge(1)],
      prices,
      now: NOW,
    });
    expect(plan.reserveUsd).toBeCloseTo((60_000 * 3 + 6_000 * 15 + 60_000 * 1 + 6_000 * 5) / 1e6);
  });
});

describe("capReason", () => {
  it("says which cap, what didn't run and when it resets, within a summary bullet", () => {
    const reasons = [
      capReason({ kind: "pr_runs", limitRuns: 5, resetsAt: new Date("2026-11-16T00:00:00Z") }, 1),
      capReason({ kind: "pr_cost", limitUsd: 2, resetsAt: new Date("2026-11-16T00:00:00Z") }, 4),
      capReason(
        { kind: "repo_monthly", limitUsd: 150, resetsAt: new Date("2026-12-01T00:00:00Z") },
        12,
      ),
      capReason({ kind: "monthly", limitUsd: 1000, resetsAt: new Date("2026-12-01T00:00:00Z") }, 3),
    ];
    expect(reasons[0]).toContain("5 runs a day, so 1 batch wasn't run");
    expect(reasons[0]).toContain("2026-11-16 00:00 UTC");
    expect(reasons[0]).toContain("someone with write access runs once past it");
    expect(reasons[1]).toContain("$2.00 a day, so 4 batches weren't run");
    expect(reasons[2]).toContain("monthly spend cap of $150.00");
    expect(reasons[2]).toContain("only the deployment's config can raise it");
    expect(reasons[3]).toContain("the deployment reached its monthly spend cap of $1000.00");
    for (const reason of reasons) expect(reason.length).toBeLessThanOrEqual(200);
  });
});

describe("liftsPrCaps", () => {
  const log = () => undefined;

  it("lifts for a review command from someone GitHub says can write", async () => {
    const permission = vi.fn(async () => "write");
    expect(await liftsPrCaps({ requested: "review", actor: "dana" }, permission, log)).toBe(true);
    expect(await liftsPrCaps({ requested: "full_review", actor: "dana" }, permission, log)).toBe(
      true,
    );
    expect(permission).toHaveBeenCalledWith("dana");
  });

  it("doesn't lift for read or triage access, a push, a replies run or a failed lookup", async () => {
    expect(await liftsPrCaps({ requested: "review", actor: "eve" }, async () => "read", log)).toBe(
      false,
    );
    expect(
      await liftsPrCaps({ requested: "review", actor: "eve" }, async () => "triage", log),
    ).toBe(false);
    expect(await liftsPrCaps({ actor: "dana" }, async () => "admin", log)).toBe(false);
    expect(
      await liftsPrCaps({ requested: "replies", actor: "dana" }, async () => "admin", log),
    ).toBe(false);
    expect(await liftsPrCaps({ requested: "review" }, async () => "admin", log)).toBe(false);
    expect(
      await liftsPrCaps(
        { requested: "review", actor: "dana" },
        async () => {
          throw new Error("GitHub is down");
        },
        log,
      ),
    ).toBe(false);
    expect(await liftsPrCaps({ requested: "review", actor: "dana" }, undefined, log)).toBe(false);
  });
});

describe("quietlyCapped", () => {
  const cap = { kind: "monthly" as const, limitUsd: 10, resetsAt: NOW };
  const run = { runId: "r2", pullRequestId: "p1" };

  it("is quiet for runs for replies and explains", async () => {
    const spend = { lastCapped: vi.fn(async () => undefined) };
    expect(await quietlyCapped(spend, run, "replies", "abc", cap)).toBe(true);
    expect(await quietlyCapped(spend, run, "explain", "abc", cap)).toBe(true);
  });

  it("is quiet when the head's latest posted run was stopped by the same cap", async () => {
    expect(
      await quietlyCapped({ lastCapped: async () => "monthly" }, run, undefined, "abc", cap),
    ).toBe(true);
    expect(
      await quietlyCapped({ lastCapped: async () => "pr_cost" }, run, "review", "abc", cap),
    ).toBe(false);
    expect(
      await quietlyCapped({ lastCapped: async () => undefined }, run, undefined, "abc", cap),
    ).toBe(false);
  });
});

describe("runCost", () => {
  it("prices each dispatched batch's reported tokens by its tier", async () => {
    const keys = runKeys("11111111-2222-4333-8444-555555555555");
    const objects = new Map<string, string>([
      [
        keys.batchOutput(0),
        JSON.stringify({
          version: 1,
          index: 0,
          findings: [],
          transcriptKeys: [],
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
        }),
      ],
      [
        keys.batchOutput(1),
        JSON.stringify({
          version: 1,
          index: 1,
          error: "timed out",
          transcriptKeys: [],
          usage: { inputTokens: 1_000_000 },
        }),
      ],
      [keys.batchOutput(2), "not json"],
    ]);
    const store = { getText: async (key: string) => objects.get(key) } as never;
    const cost = await runCost(
      store,
      "11111111-2222-4333-8444-555555555555",
      [
        { index: 0, tier: "standard" },
        { index: 1, tier: "fast" },
        { index: 2, tier: "fast" },
      ],
      budgetsSchema.parse({}),
    );
    // 3 (standard) + 1 (fast) + the fast default for the unreadable one.
    expect(cost).toBeCloseTo(3 + 1 + (60_000 * 1 + 6_000 * 5) / 1e6, 6);
  });
});

describe("crossed and spendAlerts", () => {
  it("finds the thresholds a total passed", () => {
    expect(crossed(40, 60, 100)).toEqual([0.5]);
    expect(crossed(40, 100, 100)).toEqual([0.5, 0.8, 1]);
    expect(crossed(85, 90, 100)).toEqual([]);
    expect(crossed(0, 1, 0)).toEqual([1]);
  });

  it("logs BudgetUsed and one alert per threshold passed, with no more than totals", async () => {
    const log = vi.fn();
    await spendAlerts(
      { monthTotals: async () => ({ monthUsd: 82, repos: new Map([["acme/web", 55]]) }) },
      { repo: "acme/web", addedUsd: 10 },
      { monthlyUsd: 100, repoMonthlyUsd: 100 },
      NOW,
      log,
    );
    const metric = log.mock.calls.find(([message]) => message === "spend");
    expect(metric?.[1]).toMatchObject({ BudgetUsed: 82 });
    const alerts = log.mock.calls.filter(([message]) => message === "spend cap alert");
    expect(alerts.map(([, fields]) => fields)).toEqual([
      { scope: "deployment", percent: 80, spentUsd: 82, capUsd: 100 },
      { scope: "repo acme/web", percent: 50, spentUsd: 55, capUsd: 100 },
    ]);
  });

  it("does nothing without a monthly cap", async () => {
    const monthTotals = vi.fn();
    await spendAlerts({ monthTotals }, { repo: "acme/web", addedUsd: 1 }, {}, NOW, () => undefined);
    expect(monthTotals).not.toHaveBeenCalled();
  });
});

describe("readBudgets", () => {
  it("reads LGTMOOSE_BUDGETS, or no caps when it's unset", () => {
    expect(readBudgets({}).monthlyUsd).toBeUndefined();
    expect(readBudgets({ LGTMOOSE_BUDGETS: '{"monthlyUsd":250}' }).monthlyUsd).toBe(250);
  });

  it("fails rather than run without caps someone set", () => {
    expect(() => readBudgets({ LGTMOOSE_BUDGETS: "{monthly" })).toThrow(/valid JSON/);
    expect(() => readBudgets({ LGTMOOSE_BUDGETS: '{"monthlyUsd":-5}' })).toThrow(/invalid/);
  });
});

describe("settleStaleSpend", () => {
  const RUN = "11111111-2222-4333-8444-555555555555";

  it("keeps a batch that left no output at the run's estimate per batch", async () => {
    const settle = vi.fn(async () => undefined);
    const output = JSON.stringify({
      version: 1,
      index: 0,
      findings: [],
      transcriptKeys: [],
      usage: { inputTokens: 1_000_000 },
    });
    const settled = await settleStaleSpend(
      {
        store: {
          unsettled: async () => [
            {
              runId: RUN,
              costUsd: 2,
              batches: 2,
              dispatched: [
                { index: 0, tier: "standard" },
                { index: 1, tier: "standard" },
              ],
            },
          ],
          settle,
        },
        budgets: budgetsSchema.parse({}),
      },
      { getText: async (key) => (key === runKeys(RUN).batchOutput(0) ? output : undefined) },
      NOW,
      () => undefined,
      6 * 3600 * 1000,
    );
    expect(settled).toBe(1);
    // $3 for the batch that reported, $1 (the estimate) for the one that didn't.
    expect(settle).toHaveBeenCalledWith(RUN, 4);
  });

  it("asks only for reservations older than the cut-off, and logs a failure", async () => {
    const unsettled = vi.fn(async () => [
      { runId: RUN, costUsd: 1, batches: 1, dispatched: [{ index: 0, tier: "fast" }] },
    ]);
    const log = vi.fn();
    const settled = await settleStaleSpend(
      {
        store: {
          unsettled,
          settle: async () => {
            throw new Error("database down");
          },
        },
        budgets: budgetsSchema.parse({}),
      },
      { getText: async () => undefined },
      NOW,
      log,
      60_000,
    );
    expect(unsettled).toHaveBeenCalledWith(new Date(NOW.getTime() - 60_000), expect.any(Number));
    expect(settled).toBe(0);
    expect(log).toHaveBeenCalledWith("stale spend not settled", expect.anything());
  });
});
