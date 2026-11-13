import type { HarnessErrorKind, HarnessUsage } from "../harness.js";

/**
 * What a `codex exec --json` run printed, from its JSONL events (checked against Codex 0.166):
 * `thread.started` (with `thread_id`), `turn.started`, `item.*` (an `agent_message` item holds
 * the answer text), `turn.completed` (with `usage`), `turn.failed` (with `error.message`) and
 * `error` (with `message`; "Reconnecting…" ones are retries, not failures).
 */
export interface CodexRun {
  threadId?: string;
  /** The last agent message: the answer. */
  lastMessage?: string;
  /** A `turn.completed` event was seen. */
  completed: boolean;
  /** `turn.failed`'s message, or the last `error` event's when the run ended without a turn. */
  failure?: string;
  usage: HarnessUsage;
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parses the JSONL a run printed. Lines that aren't JSON events are skipped. */
export function parseCodexEvents(stdout: string): CodexRun {
  const run: CodexRun = { completed: false, usage: {} };
  let lastError: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event === undefined) continue;
    switch (event.type) {
      case "thread.started": {
        const id = text(event.thread_id);
        if (id !== undefined) run.threadId = id;
        break;
      }
      case "item.completed": {
        const item = record(event.item);
        const message = text(item?.text);
        if (item?.type === "agent_message" && message !== undefined) run.lastMessage = message;
        break;
      }
      case "turn.completed": {
        run.completed = true;
        run.usage = addUsage(run.usage, usageOf(record(event.usage) as CodexUsage | undefined));
        break;
      }
      case "turn.failed": {
        run.failure = text(record(event.error)?.message) ?? "the turn failed";
        break;
      }
      case "error": {
        const message = text(event.message);
        if (message !== undefined && !message.startsWith("Reconnecting")) lastError = message;
        break;
      }
      default:
        break;
    }
  }
  if (!run.completed && run.failure === undefined && lastError !== undefined) {
    run.failure = lastError;
  }
  return run;
}

function usageOf(usage: CodexUsage | undefined): HarnessUsage {
  const out: HarnessUsage = {};
  if (typeof usage?.input_tokens === "number") out.inputTokens = usage.input_tokens;
  if (typeof usage?.output_tokens === "number") out.outputTokens = usage.output_tokens;
  if (typeof usage?.cached_input_tokens === "number") {
    out.cacheReadTokens = usage.cached_input_tokens;
  }
  return out;
}

export function addUsage(a: HarnessUsage, b: HarnessUsage): HarnessUsage {
  const out: HarnessUsage = { ...a };
  for (const key of Object.keys(b) as (keyof HarnessUsage)[]) {
    const value = b[key];
    if (value !== undefined) out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

export interface LimitFailure {
  kind: Extract<HarnessErrorKind, "rate_limit" | "plan_limit" | "auth">;
  retryAfterSeconds?: number;
  resetsAt?: string;
}

/**
 * Usage and spend limits of a ChatGPT plan or API account: the plan is used up until it resets,
 * so the fallback chain should try another provider. Wording from Codex 0.166's messages
 * ("You've hit your usage limit", "spend cap", "Quota exceeded") and error codes.
 */
const PLAN_LIMIT =
  /hit your usage limit|usage[_ ]limit[_ ]reached|spend cap|quota[_ ]exceeded|usage[_ ]not[_ ]included|insufficient[_ ]quota|purchase more credits/i;
/** Throttling: the same credential works again shortly. */
const RATE_LIMIT = /rate[_ -]?limit|too many requests|\b429\b|server[_ ]overloaded/i;
/** The credential itself was refused. */
const AUTH_FAILURE =
  /\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|auth error|token (?:is )?expired|refresh token|not logged in|no codex credentials/i;

const SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  second: 1,
  m: 60,
  min: 60,
  minute: 60,
  h: 3600,
  hour: 3600,
};

/** "try again in 20 seconds", "retry after 2m": the wait in seconds, when given. */
function retryAfter(message: string): number | undefined {
  const match =
    /(?:try again|retry)(?: after| in)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|h)\b/i.exec(
      message,
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const unit = match[2].toLowerCase().replace(/s$/, "");
  const factor = SECONDS[unit] ?? SECONDS[unit.slice(0, 1)] ?? 1;
  return Math.ceil(Number(match[1]) * factor);
}

/** "Try again at Nov 14, 2026 3:45 PM.": the reset time as Codex wrote it. */
function resetsAt(message: string): string | undefined {
  return /try again at (.+?)(?:\.(?:\s|$)|$)/i.exec(message)?.[1]?.trim();
}

/**
 * Whether a failure message is a plan limit, a rate limit or a refused credential, so the
 * fallback chain can react. Undefined for any other failure.
 */
export function classifyFailure(message: string): LimitFailure | undefined {
  let kind: LimitFailure["kind"];
  if (PLAN_LIMIT.test(message)) kind = "plan_limit";
  else if (RATE_LIMIT.test(message)) kind = "rate_limit";
  else if (AUTH_FAILURE.test(message)) return { kind: "auth" };
  else return undefined;
  const wait = retryAfter(message);
  const at = resetsAt(message);
  return {
    kind,
    ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
    ...(at === undefined ? {} : { resetsAt: at }),
  };
}
