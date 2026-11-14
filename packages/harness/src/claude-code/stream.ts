import { z } from "zod";
import type { HarnessUsage } from "../harness.js";
import { parseAnswer } from "../answer.js";

/** The last line of `--output-format stream-json`. Only the fields used here. */
const resultEvent = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  session_id: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
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
  const event = retryEvent.safeParse(parseLine(line));
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
