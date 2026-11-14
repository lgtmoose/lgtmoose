import { describe, expect, it } from "vitest";
import { classifyFailure, limitTimes } from "./limits.js";

describe("classifyFailure status codes", () => {
  it.each([
    ["HTTP 429", "rate_limit"],
    ["HTTP/1.1 429", "rate_limit"],
    ["status code: 429", "rate_limit"],
    ["server responded with 429", "rate_limit"],
    ["request returned 401", "auth"],
    ["failed with 401", "auth"],
    ["unexpected status 401 Unauthorized", "auth"],
  ] as const)("reads %j as %s", (message, kind) => {
    expect(classifyFailure(message)?.kind).toBe(kind);
  });

  it.each([
    "    at run (index.js:429:17)",
    "at x (cli.js:401:3)",
    "processed 429 files",
    "PR #401",
  ])("doesn't read a bare number in %j as a status", (message) => {
    expect(classifyFailure(message)).toBeUndefined();
  });
});

describe("limitTimes", () => {
  it("reads a wait and a reset time", () => {
    expect(limitTimes("try again in 2 minutes")).toEqual({ retryAfterSeconds: 120 });
    expect(limitTimes("Try again at Nov 14, 2026 3:45 PM.")).toEqual({
      resetsAt: "Nov 14, 2026 3:45 PM",
    });
    expect(limitTimes("nothing here")).toEqual({});
  });
});
