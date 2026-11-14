import { describe, expect, it } from "vitest";
import { classifyFailure } from "../limits.js";
import { parseCodexEvents } from "./stream.js";

const jsonl = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("parseCodexEvents", () => {
  it("reads the thread, the last agent message and the usage", () => {
    const run = parseCodexEvents(
      jsonl(
        { type: "thread.started", thread_id: "t-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "0", type: "reasoning", text: "thinking" } },
        { type: "item.completed", item: { id: "1", type: "agent_message", text: "first" } },
        { type: "item.completed", item: { id: "2", type: "agent_message", text: '{"ok":true}' } },
        {
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 },
        },
      ),
    );
    expect(run).toEqual({
      threadId: "t-1",
      lastMessage: '{"ok":true}',
      completed: true,
      usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 },
    });
  });

  it("takes the failure from turn.failed, and ignores reconnect notices", () => {
    const run = parseCodexEvents(
      jsonl(
        { type: "error", message: "Reconnecting... 2/5 (stream disconnected)" },
        { type: "turn.failed", error: { message: "You've hit your usage limit." } },
      ),
    );
    expect(run.failure).toBe("You've hit your usage limit.");
    expect(run.completed).toBe(false);
  });

  it("falls back to the last error event when no turn ended, and skips junk lines", () => {
    const run = parseCodexEvents(
      `not json\n${jsonl({ type: "error", message: "unexpected status 401 Unauthorized" }, [1, 2])}`,
    );
    expect(run.failure).toBe("unexpected status 401 Unauthorized");
  });
});

describe("classifyFailure", () => {
  it.each([
    ["You’ve hit your usage limit. Upgrade to Plus to continue using Codex", "plan_limit"],
    ["You hit your spend cap set in your workspace.", "plan_limit"],
    ["Quota exceeded. Check your plan and billing details.", "plan_limit"],
    ["error code: usage_not_included", "plan_limit"],
    ["exceeded retry limit, last status: 429 Too Many Requests", "rate_limit"],
    ["Rate limit reached for requests", "rate_limit"],
    ["unexpected status 401 Unauthorized", "auth"],
    ["Incorrect API key provided", "auth"],
    ["sandbox error: denied", undefined],
  ])("classifies %j as %s", (message, kind) => {
    expect(classifyFailure(message)?.kind).toBe(kind);
  });

  it("reads when to try again", () => {
    expect(classifyFailure("429 rate limit. Please try again in 2m")).toEqual({
      kind: "rate_limit",
      retryAfterSeconds: 120,
    });
    expect(
      classifyFailure("You've hit your usage limit. Try again at Nov 14, 2026 3:45 PM."),
    ).toEqual({
      kind: "plan_limit",
      resetsAt: "Nov 14, 2026 3:45 PM",
    });
  });
});
