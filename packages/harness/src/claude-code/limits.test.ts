import { describe, expect, it } from "vitest";
import { claudeLimitFailure, findResult } from "./stream.js";

const result = (fields: Record<string, unknown>) =>
  findResult(JSON.stringify({ type: "result", subtype: "success", is_error: true, ...fields }))!;

describe("claudeLimitFailure", () => {
  it("reads Claude's plan-limit wording and its reset time", () => {
    expect(
      claudeLimitFailure(
        result({ result: "You've hit your 5-hour limit · resets 3:10pm (UTC)" }),
        "",
      ),
    ).toEqual({ kind: "plan_limit", resetsAt: "3:10pm (UTC)" });
    expect(
      claudeLimitFailure(result({ result: "Claude AI usage limit reached|1763125800" }), ""),
    ).toMatchObject({ kind: "plan_limit" });
  });

  it("reads the pinned CLI's other limit messages", () => {
    for (const message of [
      "You've hit your monthly spend limit",
      "You've hit your team's shared budget",
      "You've reached your Fable limit",
      "You're out of usage credits",
    ]) {
      expect(claudeLimitFailure(result({ result: message }), ""), message).toMatchObject({
        kind: "plan_limit",
      });
    }
  });

  it("turns a relative reset into seconds, and stops a clock time at the sentence", () => {
    expect(
      claudeLimitFailure(result({ result: "You've hit your limit · resets in 3h 20m" }), ""),
    ).toEqual({ kind: "plan_limit", retryAfterSeconds: 12_000 });
    expect(
      claudeLimitFailure(
        result({
          result: "You've hit your limit. It resets 5pm. Upgrade your plan to keep going.",
        }),
        "",
      ),
    ).toEqual({ kind: "plan_limit", resetsAt: "5pm" });
  });

  it("treats HTTP 429 as throttling unless the message says the plan is used up", () => {
    expect(claudeLimitFailure(result({ api_error_status: 429, result: "Overloaded" }), "")).toEqual(
      {
        kind: "rate_limit",
      },
    );
    expect(
      claudeLimitFailure(result({ api_error_status: 429, result: "You've hit your limit" }), ""),
    ).toMatchObject({ kind: "plan_limit" });
  });

  it("reads error lists and leaves other failures alone", () => {
    expect(
      claudeLimitFailure(
        result({ subtype: "error_during_execution", errors: ["rate limit hit"] }),
        "",
      ),
    ).toMatchObject({ kind: "rate_limit" });
    expect(claudeLimitFailure(result({ result: "The model crashed." }), "")).toBeUndefined();
  });
});
