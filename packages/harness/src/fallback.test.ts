import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FallbackHarness,
  MemoryCooldownStore,
  summarizeUsage,
  type ChainProvider,
  type ProviderAttempt,
} from "./fallback.js";
import { claudeArgs } from "./claude-code/adapter.js";
import {
  HarnessError,
  type Harness,
  type HarnessResult,
  type HarnessRunOptions,
} from "./harness.js";

const schema = z.object({ ok: z.boolean() });
const NOW = new Date("2026-11-13T12:00:00Z");

/** A harness that answers from a script, one entry per call, and records what it was given. */
function scripted(
  id: string,
  script: (HarnessError | { inputTokens: number })[],
): Harness & { calls: HarnessRunOptions<unknown>[] } {
  const calls: HarnessRunOptions<unknown>[] = [];
  return {
    id,
    calls,
    run<T>(options: HarnessRunOptions<T>): Promise<HarnessResult<T>> {
      calls.push(options as HarnessRunOptions<unknown>);
      const next = script.shift() ?? { inputTokens: 1 };
      if (next instanceof HarnessError) return Promise.reject(next);
      return Promise.resolve({
        output: options.schema.parse({ ok: true }),
        usage: { inputTokens: next.inputTokens, outputTokens: 2, costUsd: 0.01 },
        transcriptKey: `transcripts/${options.runId ?? ""}/1.jsonl`,
      });
    },
  };
}

function chain(providers: ChainProvider[], store = new MemoryCooldownStore()) {
  const seen: ProviderAttempt[] = [];
  const harness = new FallbackHarness({
    providers,
    cooldowns: store,
    now: () => NOW,
    onAttempt: (attempt) => seen.push(attempt),
  });
  return { harness, store, seen };
}

const RUN = { prompt: "p", cwd: "/tmp", schema, model: "", timeoutMs: 1000, runId: "run-1" };

describe("FallbackHarness", () => {
  it("runs on the first provider with its model for the tier", async () => {
    const claude = scripted("claude-code", []);
    const { harness } = chain([
      { providerId: "claude", harness: claude, models: { deep: "opus" } },
    ]);
    const result = await harness.run({ ...RUN, tier: "deep" });
    expect(result.output).toEqual({ ok: true });
    expect(result.providerId).toBe("claude");
    expect(claude.calls[0]).toMatchObject({ model: "opus", tier: "deep", runId: "run-1/claude" });
  });

  it("moves to the next provider on a plan limit, and cools the first down until it resets", async () => {
    const limit = new HarnessError("plan_limit", "Usage limit reached.", {
      resetsAt: "2026-11-13T17:00:00Z",
    });
    const plan = scripted("claude-code", [limit]);
    const api = scripted("claude-code", []);
    const { harness, store, seen } = chain([
      { providerId: "plan", harness: plan },
      { providerId: "api", harness: api },
    ]);
    const result = await harness.run(RUN);
    expect(result.providerId).toBe("api");
    expect(seen.map((a) => a.outcome)).toEqual(["plan_limit", "ok"]);
    expect(seen[0]?.cooledUntil).toEqual(new Date("2026-11-13T17:00:00Z"));
    expect(await store.cooledUntil(["plan", "api"], NOW)).toEqual(
      new Map([["plan", new Date("2026-11-13T17:00:00Z")]]),
    );

    // The next run skips the cooling provider without calling it.
    const again = await harness.run(RUN);
    expect(again.providerId).toBe("api");
    expect(plan.calls).toHaveLength(1);
    expect(again.attempts.map((a) => a.outcome)).toEqual(["cooling_down", "ok"]);
  });

  it("uses retry-after, else a default, when there's no reset time", async () => {
    const store = new MemoryCooldownStore();
    const rate = scripted("x", [new HarnessError("rate_limit", "429", { retryAfterSeconds: 30 })]);
    const auth = scripted("y", [new HarnessError("auth", "401")]);
    const { harness, seen } = chain(
      [
        { providerId: "a", harness: rate },
        { providerId: "b", harness: auth },
        { providerId: "c", harness: scripted("z", []) },
      ],
      store,
    );
    await harness.run(RUN);
    expect(seen[0]?.cooledUntil).toEqual(new Date(NOW.getTime() + 30_000));
    expect(seen[1]?.cooledUntil).toEqual(new Date(NOW.getTime() + 10 * 60_000));
  });

  it("fails the run on other errors without trying the next provider", async () => {
    const timeout = new HarnessError("timeout", "Timed out.");
    const next = scripted("b", []);
    const { harness, seen } = chain([
      { providerId: "a", harness: scripted("a", [timeout]) },
      { providerId: "b", harness: next },
    ]);
    await expect(harness.run(RUN)).rejects.toBe(timeout);
    expect(next.calls).toHaveLength(0);
    expect(seen.map((a) => a.outcome)).toEqual(["failed"]);
  });

  it("moves on from a prompt too large for a provider, without cooling it down", async () => {
    const store = new MemoryCooldownStore();
    const next = scripted("b", []);
    const { harness, seen } = chain(
      [
        {
          providerId: "a",
          harness: scripted("a", [new HarnessError("input_too_large", "too big")]),
        },
        { providerId: "b", harness: next },
      ],
      store,
    );
    const result = await harness.run(RUN);
    expect(result.providerId).toBe("b");
    expect(seen.map((a) => a.outcome)).toEqual(["input_too_large", "ok"]);
    expect((await store.cooledUntil(["a"], NOW)).size).toBe(0);
    expect(summarizeUsage([seen]).find((u) => u.providerId === "a")).toMatchObject({
      limitHits: 0,
      fallbacks: 1,
    });
  });

  it("fails as input_too_large when no provider can take the prompt", async () => {
    const { harness } = chain([
      { providerId: "a", harness: scripted("a", [new HarnessError("input_too_large", "big")]) },
    ]);
    const error = (await harness.run(RUN).catch((e: unknown) => e)) as HarnessError;
    expect(error.kind).toBe("input_too_large");
    expect(error.message).toContain("a (input too large)");
  });

  it("says when the first provider is back when every one is limited", async () => {
    const { harness } = chain([
      {
        providerId: "a",
        harness: scripted("a", [
          new HarnessError("plan_limit", "out", { resetsAt: "2026-11-13T18:00:00Z" }),
        ]),
      },
      {
        providerId: "b",
        harness: scripted("b", [
          new HarnessError("rate_limit", "slow down", { retryAfterSeconds: 120 }),
        ]),
      },
    ]);
    const error = (await harness.run(RUN).catch((e: unknown) => e)) as HarnessError;
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.kind).toBe("rate_limit");
    expect(error.resetsAt).toBe(new Date(NOW.getTime() + 120_000).toISOString());
    expect(error.message).toContain("a (plan limit), b (rate limit)");
  });

  it("carries on when the cooldown store fails, reporting the error", async () => {
    const broken = {
      cooledUntil: () => Promise.reject(new Error("db down")),
      coolDown: () => Promise.reject(new Error("db down")),
    };
    const errors: unknown[] = [];
    const harness = new FallbackHarness({
      providers: [
        { providerId: "a", harness: scripted("a", [new HarnessError("rate_limit", "429")]) },
        { providerId: "b", harness: scripted("b", []) },
      ],
      cooldowns: broken,
      now: () => NOW,
      onStoreError: (error) => errors.push(error),
    });
    const result = await harness.run(RUN);
    expect(result.providerId).toBe("b");
    expect(result.attempts.map((a) => a.outcome)).toEqual(["rate_limit", "ok"]);
    expect(errors).toHaveLength(2);
  });

  it("refuses an empty chain or repeated provider ids", () => {
    expect(() => new FallbackHarness({ providers: [] })).toThrow();
    const h = scripted("a", []);
    expect(
      () =>
        new FallbackHarness({
          providers: [
            { providerId: "a", harness: h },
            { providerId: "a", harness: h },
          ],
        }),
    ).toThrow();
  });
});

describe("claudeArgs without a model", () => {
  it("leaves --model out, so Claude Code uses its default", () => {
    const base = { settings: "{}", sessionId: "s", resume: false };
    expect(claudeArgs({ ...base, model: "" })).not.toContain("--model");
    expect(claudeArgs({ ...base, model: "opus" })).toEqual(
      expect.arrayContaining(["--model", "opus"]),
    );
  });
});

describe("MemoryCooldownStore", () => {
  it("keeps the later of two cooldowns and forgets expired ones", async () => {
    const store = new MemoryCooldownStore();
    const later = new Date(NOW.getTime() + 60_000);
    await store.coolDown("a", later, "rate_limit");
    await store.coolDown("a", new Date(NOW.getTime() + 1000), "rate_limit");
    expect((await store.cooledUntil(["a"], NOW)).get("a")).toEqual(later);
    expect((await store.cooledUntil(["a"], new Date(later.getTime() + 1))).size).toBe(0);
  });
});

describe("summarizeUsage", () => {
  it("adds up tokens, cost, limit hits and fallbacks per provider", () => {
    const attempts: ProviderAttempt[] = [
      {
        providerId: "plan",
        tier: "standard",
        model: undefined,
        outcome: "plan_limit",
        transcriptKeys: [],
      },
      {
        providerId: "api",
        tier: "standard",
        model: "sonnet",
        outcome: "ok",
        usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.5 },
        transcriptKeys: [],
      },
      {
        providerId: "plan",
        tier: "standard",
        model: undefined,
        outcome: "cooling_down",
        transcriptKeys: [],
      },
      {
        providerId: "api",
        tier: "standard",
        model: "sonnet",
        outcome: "ok",
        usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.25 },
        transcriptKeys: [],
      },
    ];
    // Two runs: each skipped `plan` (a limit hit, then a cooldown) and finished on `api`.
    expect(summarizeUsage([attempts.slice(0, 2), attempts.slice(2)])).toEqual([
      {
        providerId: "plan",
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        limitHits: 1,
        fallbacks: 2,
      },
      {
        providerId: "api",
        runs: 2,
        inputTokens: 150,
        outputTokens: 15,
        costUsd: 0.75,
        limitHits: 0,
        fallbacks: 0,
      },
    ]);
  });

  it("doesn't count a fallback when the run had no provider left to move to", () => {
    const last: ProviderAttempt = {
      providerId: "only",
      tier: "standard",
      model: undefined,
      outcome: "rate_limit",
      transcriptKeys: [],
    };
    expect(summarizeUsage([[last]])).toEqual([
      expect.objectContaining({ providerId: "only", limitHits: 1, fallbacks: 0 }),
    ]);
  });
});
