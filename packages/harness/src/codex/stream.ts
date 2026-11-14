import type { HarnessUsage } from "../harness.js";
import { addUsage } from "../usage.js";

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
        // No message: an empty report, which counts as generic, so stderr may explain it.
        run.failure = text(record(event.error)?.message) ?? "";
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
