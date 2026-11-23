import { describe, expect, it } from "vitest";
import type { ControlDeps } from "./ports.js";
import { clearFixClaims } from "./post.js";
import {
  fixedByRecheck,
  settledFixClaims,
  verdictCounts,
  type RecheckEntry,
  type RecheckWrites,
} from "./recheck.js";

/**
 * Settling the fix claims a run's recheck looked at (NIC-1140): each one it gave a verdict on
 * whose file the review read well enough for that verdict to count (`verdictCounts`, the same
 * rule that closes a finding), whatever the verdict. Any other claim stays for the next run.
 */

const RUN = "4c1f8a2e-6b3d-4e5f-9a7b-1c2d3e4f5a6b";
const CLAIMED = "2026-11-23T10:00:00.000Z";

const target = (
  id: string,
  findingId: string,
  claimed = true,
  path = "src/a.ts",
  over: Partial<RecheckEntry> = {},
): RecheckEntry => ({
  id,
  findingId,
  fingerprint: `fp-${findingId}`,
  path,
  ruleCategory: "correctness",
  severity: "should_fix",
  ...(claimed ? { fixClaimedAt: CLAIMED } : {}),
  ...over,
});

const verdict = (id: string, confirmed: boolean) => ({
  id,
  confirmed,
  reason: confirmed ? "Still there." : "The guard handles it now.",
});

describe("settledFixClaims", () => {
  // An incremental run that reviewed src/a.ts and src/new-name.ts, and changed src/skipped.ts
  // without reviewing it.
  const context = (pathNow: [string, string][], outdated: string[] = []) =>
    verdictCounts({
      mode: "incremental",
      pathNow: new Map(pathNow),
      outdated: new Set(outdated),
      reviewed: new Set(["src/a.ts", "src/new-name.ts"]),
      unreviewed: new Set(["src/skipped.ts"]),
    });

  it("settles a claim the recheck closed, or found still there", () => {
    const counts = context([
      ["f1", "src/a.ts"],
      ["f2", "src/a.ts"],
    ]);
    const targets = [target("F1", "f1"), target("F2", "f2")];
    const verdicts = [verdict("F1", false), verdict("F2", true)];
    expect(settledFixClaims(targets, verdicts, counts)).toEqual(["f1", "f2"]);
  });

  it("settles a claim whose 'gone' verdict a re-raise held open", () => {
    const counts = context([["f1", "src/a.ts"]]);
    const targets = [target("F1", "f1")];
    const verdicts = [verdict("F1", false)];
    // Not closed: the review raised it again.
    const reraised = { reraised: new Set(["fp-f1"]), open: new Set(["f1"]) };
    expect(fixedByRecheck({ targets }, verdicts, reraised)).toEqual([]);
    expect(settledFixClaims(targets, verdicts, counts)).toEqual(["f1"]);
  });

  it("settles a protected claim held open because the verdict didn't name its fix", () => {
    const counts = context([["f1", "src/a.ts"]]);
    const targets = [target("F1", "f1", true, "src/a.ts", { ruleCategory: "authz" })];
    const verdicts = [verdict("F1", false)];
    const open = { reraised: new Set<string>(), open: new Set(["f1"]) };
    expect(fixedByRecheck({ targets }, verdicts, open)).toEqual([]);
    expect(settledFixClaims(targets, verdicts, counts)).toEqual(["f1"]);
  });

  it("keeps a claim with no verdict, or on a file the review didn't read", () => {
    const counts = context([
      ["f1", "src/a.ts"],
      ["f2", "src/skipped.ts"],
    ]);
    const targets = [target("F1", "f1"), target("F2", "f2", true, "src/skipped.ts")];
    expect(settledFixClaims(targets, [verdict("F2", true)], counts)).toEqual([]);
  });

  it("keeps a claim on a file renamed since and not reviewed under its new name", () => {
    // Raised on src/old-name.ts, at head src/other-name.ts, which this run didn't review.
    const counts = context([["f1", "src/other-name.ts"]]);
    const targets = [target("F1", "f1", true, "src/old-name.ts")];
    expect(settledFixClaims(targets, [verdict("F1", true)], counts)).toEqual([]);
    // Reviewed under its new name: the verdict counts.
    const renamed = context([["f1", "src/new-name.ts"]]);
    expect(settledFixClaims(targets, [verdict("F1", true)], renamed)).toEqual(["f1"]);
  });

  it("keeps a claim whose line is gone unless prepare saw it gone too", () => {
    const targets = [target("F1", "f1")];
    // No place at head, but neither prepare (`entry.outdated`) nor this step saw it outdated.
    expect(settledFixClaims(targets, [verdict("F1", true)], context([]))).toEqual([]);
    // This step did, prepare didn't.
    expect(settledFixClaims(targets, [verdict("F1", true)], context([], ["f1"]))).toEqual([]);
    // Both did, and the review read its file.
    const outdated = [target("F1", "f1", true, "src/a.ts", { outdated: true })];
    expect(settledFixClaims(outdated, [verdict("F1", true)], context([], ["f1"]))).toEqual(["f1"]);
  });
});

function setup() {
  const cleared: { findingId: string; fixClaimedAt: string }[][] = [];
  const deps = {
    findings: {
      async clearFixClaims(claims: readonly { findingId: string; fixClaimedAt: string }[]) {
        cleared.push([...claims]);
      },
    },
    log: () => undefined,
  } as unknown as ControlDeps;
  const manifest = {
    recheck: {
      index: 4,
      sinceSha: "a".repeat(40),
      changed: ["src/a.ts"],
      targets: [target("F1", "f1"), target("F2", "f2"), target("F3", "f3", false)],
    },
  } as unknown as Parameters<typeof clearFixClaims>[2];
  return { deps, manifest, cleared };
}

const writes = (fixed: string[], settledClaims?: string[]): RecheckWrites => ({
  version: 1,
  fixed: fixed.map((findingId) => ({ findingId, reason: "Gone." })),
  ...(settledClaims === undefined ? {} : { settledClaims }),
});

describe("clearFixClaims", () => {
  it("clears the claims of findings the plan closed or settled, as the run saw them", async () => {
    const { deps, manifest, cleared } = setup();
    await clearFixClaims(deps, RUN, manifest, writes(["f3"], ["f1"]));
    // F2 wasn't settled: its claim stays. F3 was closed but had no claim.
    expect(cleared).toEqual([[{ findingId: "f1", fixClaimedAt: CLAIMED }]]);
  });

  it("clears a closed finding's claim from a plan saved before settled claims were kept", async () => {
    const { deps, manifest, cleared } = setup();
    await clearFixClaims(deps, RUN, manifest, writes(["f2"]));
    expect(cleared).toEqual([[{ findingId: "f2", fixClaimedAt: CLAIMED }]]);
  });

  it("clears nothing when the recheck settled nothing", async () => {
    const { deps, manifest, cleared } = setup();
    await clearFixClaims(deps, RUN, manifest, writes([]));
    expect(cleared).toEqual([]);
  });
});
