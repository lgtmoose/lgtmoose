import { z } from "zod";
import { classifyFailure, limitTimes, type LimitFailure } from "../limits.js";
import { statusesIn } from "../status.js";
import type { HarnessUsage } from "../harness.js";

/**
 * What `agent -p --output-format json` prints when a run succeeds: one JSON object (see
 * https://cursor.com/docs/cli/reference/output-format). `result` holds the final answer text.
 * Recent versions add `usage` with camelCase token counts. On failure the CLI exits non-zero
 * and writes the error to stderr instead. Unknown fields are ignored, as the docs ask.
 */
const resultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    })
    .optional(),
});

export type CursorResult = z.infer<typeof resultSchema>;

/** The result object, from the last stdout line that holds one. */
export function findCursorResult(stdout: string): CursorResult | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = resultSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function cursorUsage(result: CursorResult | undefined): HarnessUsage {
  const usage = result?.usage;
  const out: HarnessUsage = {};
  if (usage?.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage?.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage?.cacheReadTokens !== undefined) out.cacheReadTokens = usage.cacheReadTokens;
  if (usage?.cacheWriteTokens !== undefined) out.cacheWriteTokens = usage.cacheWriteTokens;
  return out;
}

/** Words for a limit, and for it having been hit. */
const LIMIT = String.raw`(?:usage|spend(?:ing)?|monthly|team|plan) limit`;
const HIT = String.raw`(?:reached|exceeded|hit|met)`;
/**
 * A Cursor plan's included usage or spend limit is used up: a limit that was hit, not a mention
 * of one. Matches "You've hit your usage limit", "Your spend limit has been reached", "Spending
 * limit exceeded", "You've used up your included usage for this month", "You're out of fast
 * requests"; not "Upgrade to Pro for higher usage limits", "Check your spend limit in settings"
 * or "Your plan includes 500 requests of included usage". Words are separated by single spaces
 * and each optional part is a fixed word, so the match is linear.
 */
const PLAN_LIMIT = new RegExp(
  [
    String.raw`\b${HIT} (?:(?:your|the|its|this|a) )?(?:[a-z]+ )?${LIMIT}`,
    String.raw`\b${LIMIT} (?:has been |was |is )?${HIT}`,
    String.raw`\b(?:used up|run out of|ran out of|exhausted) (?:(?:all of|your|the|included|monthly|fast) )*(?:usage|requests|quota|credits)`,
    String.raw`\bout of (?:(?:fast|included) )?(?:requests|usage|credits)`,
  ].join("|"),
  "i",
);
/**
 * Wording that says the key was refused, or the CLI has none. Not a 403 or "forbidden": the
 * egress proxy refuses a host it doesn't allow with 403 too, and that isn't the key's fault.
 */
const AUTH_FAILURE =
  /unauthori[sz]ed|invalid api key|api key (?:is )?(?:invalid|revoked|expired)|authentication (?:required|failed)|not (?:authenticated|logged in)|agent login/i;

/**
 * Whether a Cursor failure is a plan limit, a rate limit or a refused key, so the fallback chain
 * can move on. Cursor's plan-limit wording wins, since such messages may carry a 429 or
 * `[resource_exhausted]` too; then the statuses and wording shared with Codex (`classifyFailure`);
 * then Cursor's auth wording. Undefined for any other failure.
 */
export function classifyCursorFailure(message: string): LimitFailure | undefined {
  if (PLAN_LIMIT.test(message)) return { kind: "plan_limit", ...limitTimes(message) };
  return classifyFailure(message) ?? (AUTH_FAILURE.test(message) ? { kind: "auth" } : undefined);
}

/**
 * Like `classifyCursorFailure`, but from machine signals only (`statusesIn`): bracketed
 * connect-rpc codes, HTTP statuses in their HTTP forms and JSON status fields. Never wording a
 * banner or warning could contain. For stderr behind a generic error result.
 */
export function classifyStrictCursorFailure(message: string): LimitFailure | undefined {
  const statuses = statusesIn(message);
  if (statuses.has(429)) return { kind: "rate_limit", ...limitTimes(message) };
  if (statuses.has(401)) return { kind: "auth" };
  return undefined;
}

/**
 * Error results too generic to say what went wrong, after which stderr may still hold the
 * cause.
 */
const GENERIC_ERROR =
  /^(?:request failed|unknown error|internal error|error|failed|an? (?:unexpected |unknown )?error(?: occurred)?|something went wrong)[.!]?$/i;

/** Whether an error result's text says nothing about the cause. */
export function isGenericError(text: string): boolean {
  return text.trim() === "" || GENERIC_ERROR.test(text.trim());
}
