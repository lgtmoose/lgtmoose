import { z } from "zod";
import { HarnessError, type HarnessResult, type HarnessUsage } from "../harness.js";
import { parseAnswer, repairPrompt, schemaJson, schemaPromptSuffix, truncate } from "../answer.js";
import { success } from "../attempt.js";
import type { ProcessResult } from "../process.js";
import { redact, valueContainsSecret } from "../redact.js";
import { addUsage } from "../usage.js";
import {
  classifyFailure,
  classifyReportedFailure,
  limitTimes,
  type LimitFailure,
} from "../limits.js";

/** The last line of `--output-format stream-json`. Only the fields used here. */
const resultEvent = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  session_id: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
  /** Error results (`error_during_execution` and the like) list what went wrong here. */
  errors: z.array(z.string()).optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});
export type ResultEvent = z.infer<typeof resultEvent>;

const retryEvent = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  error: z.string().optional(),
});

/** API retry causes that another try won't fix: the credential is wrong or can't be used. */
const AUTH_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "cloud_credential_error",
]);

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a stream line reports a failed API call caused by the credential. */
export function isAuthRetry(line: string): boolean {
  return isAuthRetryMessage(parseLine(line));
}

/** `isAuthRetry` for a message already parsed. */
export function isAuthRetryMessage(message: unknown): boolean {
  const event = retryEvent.safeParse(message);
  return event.success && event.data.error !== undefined && AUTH_ERRORS.has(event.data.error);
}

/** The run's result event, or undefined if the stream has none (the CLI crashed or was killed). */
export function findResult(stdout: string): ResultEvent | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const event = resultEvent.safeParse(parseLine(line));
    if (event.success) return event.data;
  }
  return undefined;
}

export function usageOf(result: ResultEvent): HarnessUsage {
  const usage: HarnessUsage = {};
  const u = result.usage;
  if (u?.input_tokens !== undefined) usage.inputTokens = u.input_tokens;
  if (u?.output_tokens !== undefined) usage.outputTokens = u.output_tokens;
  if (u?.cache_read_input_tokens !== undefined) usage.cacheReadTokens = u.cache_read_input_tokens;
  if (u?.cache_creation_input_tokens !== undefined) {
    usage.cacheWriteTokens = u.cache_creation_input_tokens;
  }
  if (result.total_cost_usd !== undefined) usage.costUsd = result.total_cost_usd;
  return usage;
}

/**
 * The model's answer as JSON: `structured_output` when `--json-schema` was used, otherwise the
 * result text (see `parseAnswer`).
 */
export function outputOf(
  result: ResultEvent,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (result.structured_output !== undefined) return { ok: true, value: result.structured_output };
  return parseAnswer(result.result);
}

/**
 * Claude's own plan-limit wording: "You've hit your 5-hour limit · resets 3:10pm (UTC)", "Claude
 * AI usage limit reached|1763125800". The shared patterns cover the rest.
 */
const CLAUDE_PLAN_LIMIT = new RegExp(
  [
    // "You've hit your limit", "… your 5-hour limit", "… your monthly spend limit",
    // "… your team's shared budget". Not a rate or request limit, which is throttling.
    String.raw`hit your (?:(?!rate\b|requests?\b)[\w'-]+ ){0,3}(?:limit|budget)`,
    // "You've reached your Fable limit"
    String.raw`reached your (?:(?!rate\b|requests?\b)[\w'-]+ ){0,3}limit`,
    // "usage limit reached", "5-hour limit reached", "Weekly limit reached"
    String.raw`(?<!\b(?:rate|requests?) )\blimit reached`,
    String.raw`out of (?:usage )?credits`,
    // The API's prepaid balance: "Your credit balance is too low to access the Anthropic API."
    String.raw`credit balance is too low`,
  ].join("|"),
  "i",
);
/** "resets 3:10pm (UTC)" or "resets in 3h 20m": when Claude Code says the limit lifts. */
const CLAUDE_RESETS = /\bresets? (?:at )?([^\n·∙]{1,60}?)\s*(?:$|\n|[·∙]|\.(?:\s|$))/i;
/** One part of a relative reset ("3h", "20m", "2 days"). */
const DURATION_PART =
  /(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?![a-z])/gi;
const UNIT_SECONDS: Record<string, number> = { d: 86_400, h: 3600, m: 60, s: 1 };

/** Classifies a Claude failure message: Claude's plan wording first, then the shared patterns. */
export function classifyClaudeFailure(message: string): LimitFailure | undefined {
  if (CLAUDE_PLAN_LIMIT.test(message)) {
    return { kind: "plan_limit", ...limitTimes(message), ...claudeReset(message) };
  }
  return classifyFailure(message);
}

/**
 * The reset Claude Code wrote, in a form the fallback chain reads: "usage limit reached|<epoch
 * seconds>" and "resets 3:10pm (UTC)" as an ISO `resetsAt`, "resets in 3h 20m" as seconds.
 */
function claudeReset(message: string): { resetsAt?: string; retryAfterSeconds?: number } {
  const epoch = /usage limit reached\|(\d{9,11})\b/i.exec(message)?.[1];
  if (epoch !== undefined) return { resetsAt: new Date(Number(epoch) * 1000).toISOString() };
  const text = CLAUDE_RESETS.exec(message)?.[1]?.trim();
  if (!text) return {};
  if (/^in\b/i.test(text)) {
    let seconds = 0;
    for (const [, count, unit] of text.matchAll(DURATION_PART)) {
      seconds += Number(count) * (UNIT_SECONDS[(unit ?? "s").charAt(0).toLowerCase()] ?? 0);
    }
    return seconds > 0 ? { retryAfterSeconds: seconds } : {};
  }
  const at = nextClockTime(text, new Date());
  return at === undefined ? {} : { resetsAt: at.toISOString() };
}

/** "3pm", "3:10pm (UTC)", "15:10 (Europe/London)": the next time the clock shows that. */
const CLOCK_TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([\w/+-]+)\))?$/i;

/**
 * When a clock time next comes round, in its time zone (UTC when it names none, which is the
 * sandbox's own zone). Undefined for anything else, such as a date or an unknown zone.
 */
export function nextClockTime(text: string, now: Date): Date | undefined {
  const match = CLOCK_TIME.exec(text);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const half = match[3]?.toLowerCase();
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  const zone = match[4] ?? "UTC";
  let offsetMs: number;
  try {
    offsetMs = zoneOffsetMs(zone, now);
  } catch {
    return undefined;
  }
  // Today's date as the zone sees it, at that time, then back to UTC.
  const local = new Date(now.getTime() + offsetMs);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const wall = day + (hour * 60 + minute) * 60_000;
  let at = wall - offsetMs;
  if (at <= now.getTime()) at += 86_400_000;
  // The offset at the reset itself, in case a daylight-saving change falls in between.
  const offsetThen = zoneOffsetMs(zone, new Date(at));
  if (offsetThen !== offsetMs) at += offsetMs - offsetThen;
  return new Date(at);
}

/** How far a time zone's wall clock is ahead of UTC at `now`. Throws for an unknown zone. */
function zoneOffsetMs(zone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return wall - Math.floor(now.getTime() / 60_000) * 60_000;
}

/**
 * Whether a failed result is a plan limit, a rate limit or a refused credential, for the
 * fallback chain. The API's status decides first (429 is throttling); then the error the CLI
 * reported (its result text or error list), and stderr for machine signals only when that
 * report is generic (`classifyReportedFailure`).
 */
export function claudeLimitFailure(result: ResultEvent, stderr: string): LimitFailure | undefined {
  const reported = [result.result, ...(result.errors ?? [])].filter(Boolean).join("\n");
  // 429 is throttling, 529 an overloaded API: both pass soon, so another provider can take the run.
  if (result.api_error_status === 429 || result.api_error_status === 529) {
    const plan = reported === "" ? undefined : classifyClaudeFailure(reported);
    return plan?.kind === "plan_limit" ? plan : { kind: "rate_limit", ...limitTimes(reported) };
  }
  return classifyReportedFailure(reported, stderr, classifyClaudeFailure);
}

/** Stop after this many API retries caused by the credential: retrying won't fix it. */
export const MAX_AUTH_RETRIES = 2;

/**
 * How to ask for the schema. An object schema goes to structured output (`--json-schema`, or
 * the SDK's `outputFormat`), which makes the CLI check the answer too. Anything else is
 * described in the prompt.
 */
export function claudeSchemaFor(schema: z.ZodType): {
  json?: Record<string, unknown>;
  promptSuffix: string;
} {
  const json = schemaJson(schema);
  if (json?.type === "object") return { json, promptSuffix: "" };
  return { promptSuffix: schemaPromptSuffix(json) };
}

/** One attempt's outcome: an answer, or what was wrong with it for the repair turn. */
export type ClaudeAttempt<T> =
  | { kind: "ok"; output: T; usage: HarnessUsage; key: string }
  | { kind: "invalid"; problems: string; usage: HarnessUsage; key: string };

/** Checks a usable result's answer against the schema, and that it holds no credential. */
export function checkAnswer<T>(
  result: ResultEvent,
  schema: z.ZodType<T>,
  secrets: readonly string[],
  keys: readonly string[],
  key: string,
): ClaudeAttempt<T> {
  const usage = usageOf(result);
  if (result.subtype === "error_max_structured_output_retries") {
    return { kind: "invalid", problems: "No output matched the schema.", usage, key };
  }
  const parsed = outputOf(result);
  if (!parsed.ok) return { kind: "invalid", problems: parsed.error, usage, key };
  const checked = schema.safeParse(parsed.value);
  if (!checked.success) {
    return { kind: "invalid", problems: z.prettifyError(checked.error), usage, key };
  }
  // A prompt-injected model could try to post the credential in a finding.
  if (valueContainsSecret(checked.data, secrets)) {
    throw new HarnessError("invalid_output", "The output contained a model credential.", {
      transcriptKeys: keys,
    });
  }
  return { kind: "ok", output: checked.data, usage, key };
}

/**
 * Runs the first attempt and, if its answer was invalid, one repair turn that resumes the same
 * session so the model sees its own answer.
 */
export async function withRepair<T>(
  attempt: (n: number, prompt: string) => Promise<ClaudeAttempt<T>>,
  firstPrompt: string,
  secrets: readonly string[],
  keys: string[],
): Promise<HarnessResult<T>> {
  const first = await attempt(1, firstPrompt);
  if (first.kind === "ok") return success(first, first.usage, keys);
  const second = await attempt(2, repairPrompt(first.problems));
  if (second.kind === "ok") return success(second, resumedUsage(first.usage, second.usage), keys);
  throw new HarnessError(
    "invalid_output",
    truncate(redact(`The output was invalid after a repair retry: ${second.problems}`, secrets)),
    { transcriptKeys: keys },
  );
}

/**
 * Usage of a first attempt plus the repair turn that resumed its session. Tokens are per run,
 * but Claude Code restores the session's saved cost on resume, so the repair's
 * `total_cost_usd` normally includes the first attempt's already. A repair that cost less
 * than the first attempt can't include it (the session's cost wasn't saved), so then the two
 * are added.
 */
export function resumedUsage(first: HarnessUsage, second: HarnessUsage): HarnessUsage {
  const sum = addUsage(first, second);
  if (
    first.costUsd !== undefined &&
    second.costUsd !== undefined &&
    second.costUsd >= first.costUsd
  ) {
    sum.costUsd = second.costUsd;
  }
  return sum;
}

/** Parses a message already in hand as a result event, as `findResult` does for a line. */
export function asResult(message: unknown): ResultEvent | undefined {
  const event = resultEvent.safeParse(message);
  return event.success ? event.data : undefined;
}

/**
 * Throws the right HarnessError when a run didn't produce a usable result: it couldn't start,
 * was stopped (deadline, output limit, credential retries) or ended without a result, or the
 * result is an error (`failIfResultFailed`). `noResult` says why there was no result.
 */
export function failIfUnusable(
  proc: ProcessResult,
  result: ResultEvent | undefined,
  context: {
    secrets: readonly string[];
    keys: readonly string[];
    timeoutMs: number;
    /** The CLI or SDK that ran, for messages. */
    name: string;
    noResult: () => string;
  },
): asserts result is ResultEvent {
  const { secrets, keys, name } = context;
  const fail = (kind: HarnessError["kind"], message: string): HarnessError =>
    new HarnessError(kind, truncate(redact(message, secrets)), { transcriptKeys: keys });
  if (proc.spawnError) throw fail("process", `Could not start ${name}: ${proc.spawnError.message}`);
  if (proc.stopped === "timeout") throw fail("timeout", `Timed out after ${context.timeoutMs} ms.`);
  if (proc.stopped === "requested") throw fail("auth", "The model API rejected the credential.");
  if (proc.stopped === "output_limit")
    throw fail("process", `${name} wrote more output than allowed.`);
  if (!result) throw fail("process", context.noResult());
  failIfResultFailed(result, proc.stderr, secrets, keys, name);
}

/**
 * Throws the HarnessError for a result that isn't an answer: a refused credential, a rate or
 * plan limit, or any other error, worded with `name` (the CLI or SDK that ran). Returns for a
 * success, and for running out of structured output retries, which a repair turn can fix.
 */
export function failIfResultFailed(
  result: ResultEvent,
  stderr: string,
  secrets: readonly string[],
  keys: readonly string[],
  name: string,
): void {
  const fail = (kind: HarnessError["kind"], message: string, extra: object = {}): HarnessError =>
    new HarnessError(kind, truncate(redact(message, secrets)), { transcriptKeys: keys, ...extra });
  if (result.api_error_status === 401 || result.api_error_status === 403) {
    throw fail("auth", `The model API rejected the credential (HTTP ${result.api_error_status}).`);
  }
  if (result.subtype === "error_max_structured_output_retries") return;
  if (result.is_error === true || result.subtype !== "success") {
    const detail = result.result || result.errors?.join("; ") || "no detail";
    const limit = claudeLimitFailure(result, stderr);
    if (limit !== undefined) {
      const { kind, ...extra } = limit;
      throw fail(kind, `${name} stopped: ${detail}`, extra);
    }
    throw fail("process", `${name} reported ${result.subtype}: ${detail}`);
  }
}
