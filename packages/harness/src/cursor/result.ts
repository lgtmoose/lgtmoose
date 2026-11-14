import { z } from "zod";
import { classifyFailure, limitTimes, type LimitFailure } from "../limits.js";
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

/**
 * A Cursor plan's included usage or spend limit is used up: a limit that was hit, not a mention
 * of one. "Upgrade to Pro for higher usage limits" and "included usage" banners don't match.
 */
const PLAN_LIMIT =
  /(?:hit|reached|exceeded|used up)\s+(?:your|the|its|this)?\s*(?:\w+\s+)?(?:usage|spend(?:ing)?)\s+limit|(?:usage|spend(?:ing)?)\s+limit\s+(?:reached|exceeded|hit)|out of (?:fast )?requests/i;
/**
 * The key was refused, or the CLI has none. A 401 only next to HTTP wording, so a line number
 * in a stack trace (`index.js:401:7`) doesn't match. Not a 403 or "forbidden": the egress proxy
 * refuses a host it doesn't allow with 403 too, and that isn't the key's fault.
 */
const AUTH_FAILURE =
  /(?:HTTP\/?[\d.]*|status(?: code)?|error|code)[\s:=]*401\b|unauthori[sz]ed|invalid api key|api key (?:is )?(?:invalid|revoked|expired)|authentication (?:required|failed)|not (?:authenticated|logged in)|agent login/i;

/**
 * Whether a Cursor failure is a plan limit, a rate limit or a refused key, so the fallback chain
 * can move on. Cursor's plan-limit wording wins, since such messages may mention a 429 too; then
 * the checks shared with Codex ("rate limit", "429", "try again in 20 seconds"); then Cursor's
 * auth wording. Undefined for any other failure.
 */
export function classifyCursorFailure(message: string): LimitFailure | undefined {
  if (PLAN_LIMIT.test(message)) return { kind: "plan_limit", ...limitTimes(message) };
  const shared = classifyFailure(message);
  if (shared !== undefined) return shared;
  if (AUTH_FAILURE.test(message)) return { kind: "auth" };
  return undefined;
}
