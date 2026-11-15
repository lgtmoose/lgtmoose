import { parseRepoConfig } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import {
  checksGate,
  checksState,
  checksToWaitFor,
  timedOutNotice,
  waitState,
  waitingForChecksRun,
} from "./checks-gate.js";

const run = (name: string, status: string, conclusion?: string) => ({ name, status, conclusion });

describe("checksToWaitFor", () => {
  it("is nothing when off, or required with nothing required", () => {
    expect(checksToWaitFor("off", ["ci"])).toBeUndefined();
    expect(checksToWaitFor("required", [])).toBeUndefined();
    expect(checksToWaitFor("required", undefined)).toBeUndefined();
  });

  it("is the required or listed names, without LGTMoose's own check or repeats", () => {
    expect(checksToWaitFor("required", ["ci", "LGTMoose", "ci"])).toEqual(["ci"]);
    expect(checksToWaitFor(["build", " test "], undefined)).toEqual(["build", "test"]);
    expect(checksToWaitFor("required", ["lgtmoose"])).toBeUndefined();
  });

  it("refuses LGTMoose's own check in the repo config", () => {
    expect(() => parseRepoConfig({ review: { wait_for_checks: ["LGTMoose"] } })).toThrow();
    expect(parseRepoConfig({}).review).toMatchObject({
      wait_for_checks: "off",
      wait_timeout_minutes: 60,
    });
  });
});

describe("checksState", () => {
  it("passes on success, neutral and skipped, from check runs or commit statuses", () => {
    expect(
      checksState(["a", "b", "c", "d"], {
        runs: [
          run("a", "completed", "success"),
          run("b", "completed", "neutral"),
          run("c", "completed", "skipped"),
        ],
        statuses: [{ context: "D", state: "success" }],
      }),
    ).toEqual({ state: "passed", failed: [], pending: [] });
  });

  it("fails on any other conclusion or a failed status, and a failure wins", () => {
    expect(
      checksState(["a", "b", "c"], {
        runs: [
          run("a", "completed", "timed_out"),
          run("b", "completed", "success"),
          run("c", "in_progress"),
        ],
        statuses: [{ context: "b", state: "error" }],
      }),
    ).toEqual({ state: "failed", failed: ["a", "b"], pending: ["c"] });
  });

  it("is pending while a check runs, or hasn't reported at all", () => {
    expect(
      checksState(["a", "b"], {
        runs: [run("a", "queued")],
        statuses: [],
      }),
    ).toEqual({ state: "pending", failed: [], pending: ["a", "b"] });
  });
});

describe("checksGate", () => {
  const settings = { wait_timeout_minutes: 10 };
  const since = new Date("2026-11-15T10:00:00Z");
  const pending = { state: "pending" as const, failed: [], pending: ["test"] };

  it("waits for pending checks until the timeout, then reviews and says so", () => {
    expect(
      checksGate({ settings, checks: pending, since, now: new Date("2026-11-15T10:09:59Z") }),
    ).toEqual({ review: false, checks: pending });
    const late = checksGate({
      settings,
      checks: pending,
      since,
      now: new Date("2026-11-15T10:10:00Z"),
    });
    expect(late).toEqual({ review: true, timedOut: { minutes: 10, pending: ["test"] } });
    expect(timedOutNotice({ minutes: 10, pending: ["test"] })).toBe(
      "This review didn't wait for CI: after 10 minutes, test still hadn't finished.",
    );
  });

  it("holds a failed check past any timeout", () => {
    const failed = { state: "failed" as const, failed: ["build"], pending: [] };
    expect(
      checksGate({ settings, checks: failed, since, now: new Date("2026-11-16T10:00:00Z") }),
    ).toEqual({ review: false, checks: failed });
  });

  it("names what it says the same way whatever the order", () => {
    expect(waitState({ state: "failed", failed: ["b", "a"], pending: [] })).toBe("failed:a,b");
    expect(waitState(pending)).toBe("pending");
  });
});

describe("waitingForChecksRun", () => {
  const gate = parseRepoConfig({}).gate;

  it("blocks with a required gate, names the checks escaped, and how to start now", () => {
    const check = waitingForChecksRun({ wait_timeout_minutes: 60 }, gate, "moose", {
      state: "failed",
      failed: ["lint @team"],
      pending: [],
    });
    expect(check).toMatchObject({ conclusion: "action_required", title: "Waiting for CI to pass" });
    expect(check?.summary).toContain("lint \\@\u2060team");
    expect(check?.summary).toContain("`@moose review`");
  });

  it("is neutral when optional, and absent when off", () => {
    const pending = { state: "pending" as const, failed: [], pending: ["test"] };
    const optional = parseRepoConfig({ gate: { check_run: "optional" } }).gate;
    expect(
      waitingForChecksRun({ wait_timeout_minutes: 5 }, optional, undefined, pending),
    ).toMatchObject({
      conclusion: "neutral",
      title: "Waiting for CI",
    });
    const off = parseRepoConfig({ gate: { check_run: "off" } }).gate;
    expect(
      waitingForChecksRun({ wait_timeout_minutes: 5 }, off, undefined, pending),
    ).toBeUndefined();
  });
});
