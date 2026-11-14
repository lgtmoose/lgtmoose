import type { HarnessErrorKind } from "./harness.js";
import { HeadTail } from "./headtail.js";
import { statusesIn } from "./status.js";

/**
 * Failure wording the CLIs share: plan and spend limits, throttling and refused credentials, with
 * any wait or reset time the message gives. First collected from Codex 0.166's messages; the
 * cursor adapter adds its own wording on top (see `classifyCursorFailure`).
 */
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
/** Throttling wording: the same credential works again shortly. */
const RATE_LIMIT = /rate[_ -]?limit|too many requests|server[_ ]overloaded/i;
/** Wording that says the credential itself was refused. */
const AUTH_FAILURE =
  /unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|auth error|token (?:is )?expired|refresh token|not logged in|no codex credentials/i;

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
  // Bounded and on one line, so a long message can't make the lazy match quadratic.
  return /try again at ([^\n]{1,80}?)(?:\.(?:\s|$)|$)/im.exec(message)?.[1]?.trim();
}

/**
 * Whether a failure message is a plan limit, a rate limit or a refused credential, so the
 * fallback chain can react. Undefined for any other failure. A long message is read the way
 * stderr is kept (`HeadTail`): its start and its end.
 */
export function classifyFailure(whole: string): LimitFailure | undefined {
  const message = HeadTail.of(whole);
  let kind: LimitFailure["kind"];
  const statuses = statusesIn(message);
  if (PLAN_LIMIT.test(message)) kind = "plan_limit";
  else if (statuses.has(429) || RATE_LIMIT.test(message)) kind = "rate_limit";
  else if (statuses.has(401) || AUTH_FAILURE.test(message)) return { kind: "auth" };
  else return undefined;
  return { kind, ...limitTimes(message) };
}

/**
 * Whether raw output (stderr) reports a rate limit or a refused credential, from machine signals
 * only (`statusesIn`): bracketed connect-rpc codes, HTTP statuses in their HTTP forms and JSON
 * status fields. Never wording: stderr carries banners, warnings and log lines that mention
 * limits without hitting one. A long text is read at its start and end (`HeadTail`).
 */
export function classifyMachineSignals(whole: string): LimitFailure | undefined {
  const message = HeadTail.of(whole);
  const statuses = statusesIn(message);
  if (statuses.has(429)) return { kind: "rate_limit", ...limitTimes(message) };
  if (statuses.has(401)) return { kind: "auth" };
  return undefined;
}

/** When a limit the message reports resets: the wait it gives, the time it names, or both. */
export function limitTimes(message: string): { retryAfterSeconds?: number; resetsAt?: string } {
  const wait = retryAfter(message);
  const at = resetsAt(message);
  return {
    ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
    ...(at === undefined ? {} : { resetsAt: at }),
  };
}

/** Error-class prefixes ("Error: ", "ConnectError: ") a generic message may carry. */
const ERROR_PREFIX = /^(?:[a-z]*error\s*:\s*)+/i;
/** Error results too generic to say what went wrong. */
const GENERIC_ERROR =
  /^(?:request failed|unknown error|internal error|error|failed|an? (?:unexpected |unknown |internal )?error(?: occurred| has occurred)?|something went wrong)$/i;
/**
 * Sentences that say nothing about the cause: what to do next, or only an identifier ("Request
 * ID: 1234", "Trace ID: abc", "Error code: 13"). An error code that is an HTTP status (4xx, 5xx)
 * isn't a hint: it may be the cause.
 */
const HINT = new RegExp(
  [
    String.raw`(?:please )?(?:try again(?: later| in a (?:moment|few minutes))?|retry(?: later)?)`,
    String.raw`see .{0,200} for (?:more )?details`,
    String.raw`check the logs(?: for (?:more )?details)?`,
    String.raw`contact support`,
    String.raw`(?:request|trace|correlation|span) id:? ?[\w-]{1,100}`,
    String.raw`error code:? ?(?![45]\d\d\b)[\w-]{1,40}`,
  ]
    .map((form) => `^(?:${form})$`)
    .join("|"),
  "i",
);

/**
 * Whether an error result's text says nothing about the cause. Its error-class prefixes go,
 * then its sentences (split at sentence ends and line breaks) that are only hints or
 * identifiers ("Please try again.", "Request ID: 1234."). What's left must be empty or one
 * generic phrase ("Request failed", "An unexpected error occurred"); any other sentence names a
 * cause, which makes the result specific.
 */
export function isGenericError(text: string): boolean {
  const sentences = text
    .trim()
    .replace(ERROR_PREFIX, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/[.!?]+$/, ""))
    .filter((sentence) => sentence !== "" && !HINT.test(sentence));
  return (
    sentences.length === 0 || (sentences.length === 1 && GENERIC_ERROR.test(sentences[0] ?? ""))
  );
}

/**
 * Classifies a failed run from the error the CLI reported on purpose (`reported`: Cursor's JSON
 * error result, Codex's failure event) and its raw stderr. Wording is read only in the report,
 * with `classify`. stderr is read for machine signals only (`classifyMachineSignals`): when
 * there's no report, or when the report is generic ("Request failed") and so may have its
 * cause in stderr. A specific report that doesn't classify is left alone.
 */
export function classifyReportedFailure(
  reported: string | undefined,
  stderr: string | undefined,
  classify: (message: string) => LimitFailure | undefined,
): LimitFailure | undefined {
  const raw = stderr?.trim() || undefined;
  const report = reported?.trim() || undefined;
  if (report === undefined) return raw === undefined ? undefined : classifyMachineSignals(raw);
  const fromReport = classify(report);
  if (fromReport !== undefined || raw === undefined || !isGenericError(report)) return fromReport;
  return classifyMachineSignals(raw);
}
