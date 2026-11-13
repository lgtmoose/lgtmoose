import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECISION_CONFIG,
  countFindings,
  decide,
  type DecisionConfig,
  type DecisionContext,
  type OpenFinding,
} from "./decision.js";
import type { Severity } from "./severity.js";

const CLEAN: DecisionContext = { complete: true, injectionFlagged: false, headMoved: false };

const open = (...severities: Severity[]): OpenFinding[] =>
  severities.map((severity) => ({ severity }));

function config(gate: Partial<DecisionConfig["gate"]> = {}): DecisionConfig {
  return {
    gate: { ...DEFAULT_DECISION_CONFIG.gate, ...gate },
    labels: { pending: "needs-review", changes: "changes-requested", approved: "lgtm" },
  };
}

describe("decide", () => {
  it("requests changes when a blocking finding is open", () => {
    expect(decide(open("nit", "blocking", "should_fix"), CLEAN, config())).toEqual({
      outcome: "request_changes",
      event: "REQUEST_CHANGES",
      label: "changes-requested",
      conclusion: "failure",
      holds: [],
      counts: { blocking: 1, should_fix: 1, nit: 1 },
    });
  });

  it("comments when only should-fix findings are open, without failing the check", () => {
    expect(decide(open("should_fix", "nit"), CLEAN, config())).toMatchObject({
      outcome: "comment",
      event: "COMMENT",
      label: "changes-requested",
      conclusion: "neutral",
    });
  });

  it("approves when only nits are open, or nothing is", () => {
    for (const findings of [open("nit", "nit"), open()]) {
      expect(decide(findings, CLEAN, config())).toMatchObject({
        outcome: "approve",
        event: "APPROVE",
        label: "lgtm",
        conclusion: "success",
        holds: [],
      });
    }
  });

  it("counts findings from other reviewers the same way, whatever else they carry", () => {
    const fromOthers = [{ severity: "blocking" as const, source: "human" }];
    expect(decide(fromOthers, CLEAN).outcome).toBe("request_changes");
  });

  it.each([
    ["incomplete", { ...CLEAN, complete: false }, ["incomplete"]],
    ["prompt injection", { ...CLEAN, injectionFlagged: true }, ["prompt_injection"]],
    [
      "both",
      { ...CLEAN, complete: false, injectionFlagged: true },
      ["incomplete", "prompt_injection"],
    ],
  ])("never approves a clean review that is held (%s)", (_, context, holds) => {
    expect(decide(open("nit"), context, config())).toEqual({
      outcome: "comment",
      event: "COMMENT",
      label: "needs-review",
      conclusion: "action_required",
      holds,
      counts: { blocking: 0, should_fix: 0, nit: 1 },
    });
  });

  it("asks a person to look when a held review also has should-fix findings", () => {
    const held = { ...CLEAN, complete: false };
    expect(decide(open("should_fix"), held, config())).toMatchObject({
      event: "COMMENT",
      label: "changes-requested",
      conclusion: "action_required",
      holds: ["incomplete"],
    });
  });

  it("still requests changes on a held review with a blocking finding", () => {
    const held = { ...CLEAN, injectionFlagged: true };
    expect(decide(open("blocking"), held, config())).toMatchObject({
      event: "REQUEST_CHANGES",
      conclusion: "failure",
      holds: ["prompt_injection"],
    });
  });

  it("skips the decision when the head moved: COMMENT, labels left alone", () => {
    const moved = { ...CLEAN, headMoved: true, complete: false };
    expect(decide(open("blocking"), moved, config())).toEqual({
      outcome: "skipped",
      event: "COMMENT",
      label: undefined,
      conclusion: "skipped",
      holds: [],
      counts: { blocking: 1, should_fix: 0, nit: 0 },
    });
  });

  describe("gate.approve: false", () => {
    const noApprove = config({ approve: false });

    it("comments instead of approving, but keeps the approved label and a passing check", () => {
      expect(decide(open(), CLEAN, noApprove)).toMatchObject({
        outcome: "approve",
        event: "COMMENT",
        label: "lgtm",
        conclusion: "success",
        holds: ["approve_disabled"],
      });
    });

    it("lists the setting alongside other holds", () => {
      const held = { ...CLEAN, complete: false };
      expect(decide(open(), held, noApprove).holds).toEqual(["incomplete", "approve_disabled"]);
    });

    it("doesn't change a request for changes", () => {
      expect(decide(open("blocking"), CLEAN, noApprove).event).toBe("REQUEST_CHANGES");
    });
  });

  describe("gate.check_run", () => {
    it("makes failing and held checks neutral when optional", () => {
      const optional = config({ check_run: "optional" });
      expect(decide(open("blocking"), CLEAN, optional).conclusion).toBe("neutral");
      expect(decide(open(), { ...CLEAN, complete: false }, optional).conclusion).toBe("neutral");
      expect(decide(open("should_fix"), CLEAN, optional).conclusion).toBe("neutral");
      expect(decide(open(), CLEAN, optional).conclusion).toBe("success");
      expect(decide(open(), { ...CLEAN, headMoved: true }, optional).conclusion).toBe("skipped");
    });

    it("posts no check run when off, but still decides", () => {
      const off = config({ check_run: "off" });
      expect(decide(open("blocking"), CLEAN, off)).toMatchObject({
        event: "REQUEST_CHANGES",
        conclusion: undefined,
      });
      expect(decide(open(), { ...CLEAN, headMoved: true }, off).conclusion).toBeUndefined();
    });
  });

  it("ignores nit_cap: nits never block, however many", () => {
    const many = open(...Array.from({ length: 50 }, () => "nit" as const));
    expect(decide(many, CLEAN, config({ nit_cap: 0 })).event).toBe("APPROVE");
  });

  it("uses the default labels and gate without a config", () => {
    expect(decide(open("should_fix"), CLEAN)).toMatchObject({
      label: "Requires Changes",
      conclusion: "neutral",
    });
    expect(decide(open(), { ...CLEAN, complete: false }).label).toBe("Ready for Review");
    expect(decide(open(), CLEAN).label).toBe("Approved");
  });
});

describe("countFindings", () => {
  it("counts by severity", () => {
    expect(countFindings(open("nit", "blocking", "nit"))).toEqual({
      blocking: 1,
      should_fix: 0,
      nit: 2,
    });
  });
});
