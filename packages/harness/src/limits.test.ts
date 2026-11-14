import { describe, expect, it } from "vitest";
import { limitTimes } from "./limits.js";

// The message forms classifyFailure reads are in classification.test.ts.

describe("limitTimes", () => {
  it("reads a wait and a reset time", () => {
    expect(limitTimes("try again in 2 minutes")).toEqual({ retryAfterSeconds: 120 });
    expect(limitTimes("Try again at Nov 14, 2026 3:45 PM.")).toEqual({
      resetsAt: "Nov 14, 2026 3:45 PM",
    });
    expect(limitTimes("nothing here")).toEqual({});
  });
});
