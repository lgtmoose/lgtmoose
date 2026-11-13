import { randomUUID } from "node:crypto";
import {
  HarnessError,
  type Harness,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessUsage,
  type ModelTier,
} from "./harness.js";

/** One provider in a fallback chain: an id from the deploy config, its harness and models. */
export interface ChainProvider {
  providerId: string;
  harness: Harness;
  /** Models per tier (see `modelFor` in @lgtmoose/config). A tier left out uses `options.model`. */
  models?: Partial<Record<ModelTier, string>>;
}

/**
 * Where providers' cooldowns are kept, so one run's limit hit is seen by the next batch and the
 * next run. `@lgtmoose/db` has a Postgres one; `MemoryCooldownStore` is for tests and the CLI.
 */
export interface CooldownStore {
  /** When each of these providers can be used again; providers not cooling down are left out. */
  cooledUntil(providerIds: readonly string[], now: Date): Promise<ReadonlyMap<string, Date>>;
  /** Keeps a provider out until `until`. A later cooldown already stored wins. */
  coolDown(providerId: string, until: Date, reason: CooldownReason): Promise<void>;
}

export type CooldownReason = "rate_limit" | "plan_limit" | "auth";

/** A cooldown store in memory, for one process. */
export class MemoryCooldownStore implements CooldownStore {
  private readonly until = new Map<string, Date>();

  cooledUntil(providerIds: readonly string[], now: Date): Promise<ReadonlyMap<string, Date>> {
    const result = new Map<string, Date>();
    for (const id of providerIds) {
      const until = this.until.get(id);
      if (until !== undefined && until > now) result.set(id, until);
    }
    return Promise.resolve(result);
  }

  coolDown(providerId: string, until: Date, _reason?: CooldownReason): Promise<void> {
    const current = this.until.get(providerId);
    if (current === undefined || until > current) this.until.set(providerId, until);
    return Promise.resolve();
  }
}

/**
 * What happened on one provider during a run:
 * - `ok`: it produced the output.
 * - `rate_limit`, `plan_limit`, `auth`: it failed that way, so the run moved on (fell back).
 * - `cooling_down`: skipped without a call, because an earlier limit hit hasn't reset yet.
 * - `failed`: any other failure, which ends the run (no fallback for timeouts or bad output).
 */
export interface ProviderAttempt {
  providerId: string;
  tier: ModelTier;
  model: string | undefined;
  outcome: "ok" | CooldownReason | "cooling_down" | "failed";
  usage?: HarnessUsage;
  /** When the provider can be used again, for limit hits and skips. */
  cooledUntil?: Date;
  /** The failure's kind and message, for anything but `ok`. Never holds a credential. */
  error?: string;
  transcriptKeys: readonly string[];
}

export interface FallbackHarnessOptions {
  /** In fallback order; the first is tried first. At least one. */
  providers: readonly ChainProvider[];
  cooldowns?: CooldownStore;
  now?: () => Date;
  /** How long a provider sits out when the CLI doesn't say when its limit resets. */
  defaultCooldownMs?: Partial<Record<CooldownReason, number>>;
  /** Called after each attempt, in order, whether the run ends well or not. */
  onAttempt?: (attempt: ProviderAttempt) => void;
}

/** What a run through the chain returns: the result, the provider that produced it, every try. */
export interface FallbackResult<T> extends HarnessResult<T> {
  providerId: string;
  attempts: ProviderAttempt[];
}

/**
 * Defaults when the CLI gives no reset time: a minute for a rate limit, an hour for a used-up
 * plan (they reset on the plan's own schedule, often hours away), ten minutes for a rejected
 * credential (it won't fix itself, but the broker may replace it).
 */
export const DEFAULT_COOLDOWN_MS: Readonly<Record<CooldownReason, number>> = {
  rate_limit: 60_000,
  plan_limit: 60 * 60_000,
  auth: 10 * 60_000,
};

/** Failures the chain moves on from. Anything else is about the batch, not the provider. */
const FALLBACK_KINDS: ReadonlySet<string> = new Set(["rate_limit", "plan_limit", "auth"]);

/** The latest cooldown the error allows, from its reset time or retry-after, else the default. */
function cooldownEnd(error: HarnessError, now: Date, defaultMs: number): Date {
  const resets = error.resetsAt === undefined ? Number.NaN : Date.parse(error.resetsAt);
  if (Number.isFinite(resets) && resets > now.getTime()) return new Date(resets);
  if (error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0) {
    return new Date(now.getTime() + error.retryAfterSeconds * 1000);
  }
  return new Date(now.getTime() + defaultMs);
}

/**
 * Runs a batch on the first provider that can take it. A rate limit, a used-up plan or a
 * rejected credential puts that provider in a cooldown (until its reset time, when the CLI
 * says) and moves on to the next; providers still cooling down are skipped without a call. Any
 * other failure (a timeout, invalid output) ends the run, as with a single harness: it's about
 * the batch, and another provider would most likely fail the same way.
 *
 * Each provider gets the model for the run's tier from its own `models`, else `options.model`.
 * Its transcripts go under `<runId>/<providerId>`, so attempts don't overwrite each other.
 */
export class FallbackHarness implements Harness {
  readonly id = "fallback";
  private readonly options: FallbackHarnessOptions;
  private readonly cooldowns: CooldownStore;
  private readonly now: () => Date;

  constructor(options: FallbackHarnessOptions) {
    if (options.providers.length === 0) throw new Error("A fallback chain needs a provider.");
    const ids = options.providers.map((p) => p.providerId);
    if (new Set(ids).size !== ids.length) throw new Error("Provider ids in a chain must differ.");
    this.options = options;
    this.cooldowns = options.cooldowns ?? new MemoryCooldownStore();
    this.now = options.now ?? (() => new Date());
  }

  async run<T>(options: HarnessRunOptions<T>): Promise<FallbackResult<T>> {
    const tier = options.tier ?? "standard";
    const runId = options.runId ?? randomUUID();
    const providers = this.options.providers;
    const cooling = await this.cooldowns.cooledUntil(
      providers.map((p) => p.providerId),
      this.now(),
    );
    const attempts: ProviderAttempt[] = [];
    const record = (attempt: ProviderAttempt) => {
      attempts.push(attempt);
      this.options.onAttempt?.(attempt);
    };
    let lastLimit: HarnessError | undefined;

    for (const provider of providers) {
      const model = provider.models?.[tier] ?? (options.model || undefined);
      const until = cooling.get(provider.providerId);
      if (until !== undefined) {
        record({
          providerId: provider.providerId,
          tier,
          model,
          outcome: "cooling_down",
          cooledUntil: until,
          transcriptKeys: [],
        });
        continue;
      }
      try {
        const result = await provider.harness.run({
          ...options,
          model: model ?? "",
          tier,
          runId: `${runId}/${provider.providerId}`,
        });
        record({
          providerId: provider.providerId,
          tier,
          model,
          outcome: "ok",
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          transcriptKeys: result.transcriptKeys ?? [result.transcriptKey],
        });
        return { ...result, providerId: provider.providerId, attempts };
      } catch (error) {
        const failure = error instanceof HarnessError ? error : undefined;
        const kind = failure?.kind;
        const message =
          failure === undefined ? String(error) : `${failure.kind}: ${failure.message}`;
        if (failure === undefined || kind === undefined || !FALLBACK_KINDS.has(kind)) {
          record({
            providerId: provider.providerId,
            tier,
            model,
            outcome: "failed",
            error: message,
            transcriptKeys: failure?.transcriptKeys ?? [],
          });
          throw error;
        }
        const reason = kind as CooldownReason;
        const now = this.now();
        const end = cooldownEnd(
          failure,
          now,
          this.options.defaultCooldownMs?.[reason] ?? DEFAULT_COOLDOWN_MS[reason],
        );
        await this.cooldowns.coolDown(provider.providerId, end, reason);
        record({
          providerId: provider.providerId,
          tier,
          model,
          outcome: reason,
          cooledUntil: end,
          error: message,
          transcriptKeys: failure.transcriptKeys,
        });
        lastLimit = failure;
      }
    }

    throw this.exhausted(attempts, lastLimit);
  }

  /** The error when no provider could take the run: the soonest any of them is back. */
  private exhausted(attempts: readonly ProviderAttempt[], last: HarnessError | undefined) {
    const ends = attempts
      .map((attempt) => attempt.cooledUntil)
      .filter((end): end is Date => end !== undefined)
      .sort((a, b) => a.getTime() - b.getTime());
    const soonest = ends[0];
    const kind =
      last?.kind ?? (attempts.some((a) => a.outcome === "cooling_down") ? "rate_limit" : "process");
    const tried = attempts
      .map((a) => `${a.providerId} (${a.outcome.replace("_", " ")})`)
      .join(", ");
    const back = soonest === undefined ? "" : ` The first is back at ${soonest.toISOString()}.`;
    return new HarnessError(kind, `No provider could take the run: ${tried}.${back}`, {
      transcriptKeys: attempts.flatMap((a) => a.transcriptKeys),
      ...(soonest === undefined ? {} : { resetsAt: soonest.toISOString() }),
      ...(last === undefined ? {} : { cause: last }),
    });
  }
}

/** Usage for one provider over a run's attempts, for the summary comment's footer. */
export interface ProviderUsageSummary {
  providerId: string;
  /** Attempts that produced output. */
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Rate limits, used-up plans and rejected credentials. */
  limitHits: number;
  /** Times a run moved past this provider to the next (a limit hit or a cooldown skip). */
  fallbacks: number;
}

/**
 * Adds up attempts per provider, in the order providers first appear. Takes each run's attempts
 * separately (`FallbackResult.attempts`, or those `onAttempt` saw for one run): a limit hit
 * counts as a fallback only when the same run went on to another provider.
 */
export function summarizeUsage(
  runs: readonly (readonly ProviderAttempt[])[],
): ProviderUsageSummary[] {
  const byProvider = new Map<string, ProviderUsageSummary>();
  for (const attempts of runs) {
    attempts.forEach((attempt, i) => add(byProvider, attempt, i < attempts.length - 1));
  }
  return [...byProvider.values()];
}

function add(
  byProvider: Map<string, ProviderUsageSummary>,
  attempt: ProviderAttempt,
  movedOn: boolean,
): void {
  const entry = byProvider.get(attempt.providerId) ?? {
    providerId: attempt.providerId,
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    limitHits: 0,
    fallbacks: 0,
  };
  if (attempt.outcome === "ok") entry.runs += 1;
  if (FALLBACK_KINDS.has(attempt.outcome)) entry.limitHits += 1;
  if (movedOn && attempt.outcome !== "ok" && attempt.outcome !== "failed") entry.fallbacks += 1;
  entry.inputTokens += attempt.usage?.inputTokens ?? 0;
  entry.outputTokens += attempt.usage?.outputTokens ?? 0;
  entry.costUsd += attempt.usage?.costUsd ?? 0;
  byProvider.set(attempt.providerId, entry);
}
