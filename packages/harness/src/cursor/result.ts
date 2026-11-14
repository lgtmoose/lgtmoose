import { z } from "zod";
import { classifyFailure, type LimitFailure } from "../codex/stream.js";
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

/** A Cursor plan's included usage or spend limit is used up. */
const PLAN_LIMIT =
  /usage limit|out of (?:fast )?requests|spend(?:ing)? limit|upgrade (?:your plan|to (?:pro|ultra))|included usage/i;
/** The key was refused, or the CLI has none. */
const AUTH_FAILURE =
  /\b40[13]\b|unauthori[sz]ed|forbidden|invalid api key|api key (?:is )?(?:invalid|revoked|expired)|authentication (?:required|failed)|not (?:authenticated|logged in)|agent login/i;

/**
 * Whether a Cursor failure is a plan limit, a rate limit or a refused key, so the fallback chain
 * can move on. The wording checks shared with Codex ("rate limit", "429", "try again in 20
 * seconds") come first, then Cursor's own. Undefined for any other failure.
 */
export function classifyCursorFailure(message: string): LimitFailure | undefined {
  const shared = classifyFailure(message);
  if (shared !== undefined) return shared;
  if (PLAN_LIMIT.test(message)) return { kind: "plan_limit" };
  if (AUTH_FAILURE.test(message)) return { kind: "auth" };
  return undefined;
}
