import { describe, expect, it } from "vitest";
import { claudeLimitFailure, findResult, nextClockTime } from "./stream.js";

const result = (fields: Record<string, unknown>) =>
  findResult(JSON.stringify({ type: "result", subtype: "success", is_error: true, ...fields }))!;

describe("claudeLimitFailure", () => {
  it("reads Claude's plan-limit wording and its reset time", () => {
    expect(
      claudeLimitFailure(
        result({ result: "You've hit your 5-hour limit · resets 3:10pm (UTC)" }),
        "",
      ),
    ).toEqual({ kind: "plan_limit", resetsAt: expect.stringMatching(/T15:10:00\.000Z$/) });
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
    ).toEqual({ kind: "plan_limit", resetsAt: expect.stringMatching(/T17:00:00\.000Z$/) });
  });

  it("reads the API's low credit balance as a plan limit, and a rate limit as throttling", () => {
    expect(
      claudeLimitFailure(
        result({ result: "Your credit balance is too low to access the Anthropic API." }),
        "",
      ),
    ).toMatchObject({ kind: "plan_limit" });
    expect(
      claudeLimitFailure(
        result({ api_error_status: 429, result: "You've hit your rate limit" }),
        "",
      ),
    ).toMatchObject({ kind: "rate_limit" });
  });

  it("turns the epoch form into an ISO reset time", () => {
    expect(
      claudeLimitFailure(result({ result: "Claude AI usage limit reached|1763125800" }), ""),
    ).toMatchObject({ kind: "plan_limit", resetsAt: "2025-11-14T13:10:00.000Z" });
  });

  it("finds the next time a clock time comes round", () => {
    const now = new Date("2026-11-14T14:00:00Z");
    expect(nextClockTime("3:10pm (UTC)", now)?.toISOString()).toBe("2026-11-14T15:10:00.000Z");
    expect(nextClockTime("1pm", now)?.toISOString()).toBe("2026-11-15T13:00:00.000Z");
    // London is on GMT in November.
    expect(nextClockTime("15:30 (Europe/London)", now)?.toISOString()).toBe(
      "2026-11-14T15:30:00.000Z",
    );
    expect(nextClockTime("9am (America/New_York)", now)?.toISOString()).toBe(
      "2026-11-15T14:00:00.000Z",
    );
    // Across the spring change: 03:10 BST the next morning is 02:10 UTC.
    expect(
      nextClockTime("3:10am (Europe/London)", new Date("2027-03-27T23:30:00Z"))?.toISOString(),
    ).toBe("2027-03-28T02:10:00.000Z");
    expect(nextClockTime("Nov 20", now)).toBeUndefined();
    expect(nextClockTime("3pm (Not/AZone)", now)).toBeUndefined();
  });

  it("reads '<window> limit reached', the ∙ separator and compact durations", () => {
    expect(
      claudeLimitFailure(result({ result: "Weekly limit reached ∙ resets Nov 18, 10am" }), ""),
    ).toMatchObject({ kind: "plan_limit" });
    expect(
      claudeLimitFailure(
        result({ result: "You've hit your limit ∙ resets in 3h20m ∙ /upgrade" }),
        "",
      ),
    ).toEqual({ kind: "plan_limit", retryAfterSeconds: 12_000 });
    expect(
      claudeLimitFailure(
        result({ result: "You've hit your limit ∙ resets 3pm (UTC) ∙ /upgrade" }),
        "",
      ),
    ).toEqual({ kind: "plan_limit", resetsAt: expect.stringMatching(/T15:00:00\.000Z$/) });
  });

  it("leaves context and per-minute limits alone, and reads decimal resets", () => {
    for (const message of [
      "Context limit reached · /compact or /clear to continue",
      "You've hit your context limit",
    ]) {
      expect(claudeLimitFailure(result({ result: message }), ""), message).toBeUndefined();
    }
    expect(
      claudeLimitFailure(result({ result: "Tokens per minute limit reached" }), ""),
    ).not.toMatchObject({ kind: "plan_limit" });
    expect(
      claudeLimitFailure(result({ result: "You've hit your limit · resets in 2.5 hours" }), ""),
    ).toEqual({ kind: "plan_limit", retryAfterSeconds: 9000 });
  });

  it("treats an overloaded API (529) as throttling, and reads hrs and mins", () => {
    expect(
      claudeLimitFailure(result({ api_error_status: 529, result: "API Error: 529" }), ""),
    ).toEqual({ kind: "rate_limit" });
    expect(
      claudeLimitFailure(result({ result: "You've hit your limit · resets in 2 hrs 5 mins" }), ""),
    ).toEqual({ kind: "plan_limit", retryAfterSeconds: 7500 });
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
