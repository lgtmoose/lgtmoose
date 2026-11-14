import type { HarnessErrorKind } from "./harness.js";

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
/** HTTP status texts, by code, that may follow the number. */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  401: "Unauthorized",
  429: "Too Many Requests",
};
/** A count, not a status: "returned 429 results". */
const NOT_A_STATUS = String.raw`(?!\s*(?:results?|matches|files?|items?|lines?|records?|rows?|entries|bytes|tokens|ms|seconds?|times|changed)\b)`;

/**
 * An HTTP status in a message, as a regex source: the code right after HTTP wording, so a line
 * number in a stack trace (`index.js:429:17`) or a count ("search returned 429 results")
 * doesn't count. The wordings:
 * - "HTTP 429", "HTTP/1.1 401";
 * - "status 401", "status code: 429", "statusCode: 429", "status_code=401";
 * - an error name or "error" before it: "AuthenticationError: 401", "HTTPError: 401",
 *   "ServerError: 429", "error 401";
 * - "code 401", "code: 429";
 * - the code with its status text: "401 Unauthorized", "429 Too Many Requests" (which covers
 *   "returned 429 Too Many Requests").
 */
export function httpStatus(code: number): string {
  const text = STATUS_TEXT[code];
  const prefixed = String.raw`(?:\bHTTP(?:\/[\d.]+)?|\bstatus(?:[ _]?code)?|\w*error|\bcode)[\s:=]*${code}\b${NOT_A_STATUS}`;
  return text === undefined ? prefixed : String.raw`${prefixed}|\b${code}\s+${text}\b`;
}

/** Throttling: the same credential works again shortly. */
const RATE_LIMIT = new RegExp(
  String.raw`rate[_ -]?limit|too many requests|${httpStatus(429)}|server[_ ]overloaded`,
  "i",
);
/** The credential itself was refused. A 401 only as a status (`httpStatus`). */
const AUTH_FAILURE = new RegExp(
  String.raw`${httpStatus(401)}|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|auth error|token (?:is )?expired|refresh token|not logged in|no codex credentials`,
  "i",
);

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
  return { kind, ...limitTimes(message) };
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
