import { describe, expect, it } from "vitest";
import type { ControlDeps } from "./ports.js";
import { clearFixClaims } from "./post.js";
import { settledFixClaims, type RecheckEntry, type RecheckWrites } from "./recheck.js";

/**
 * Settling the fix claims a run's recheck looked at (NIC-1140): only those it closed, or whose
 * verdict says the problem is still there on a file the review read. Any other claim (no
 * verdict, or a "fixed" verdict the post step didn't act on) stays for the next run.
 */

const RUN = "4c1f8a2e-6b3d-4e5f-9a7b-1c2d3e4f5a6b";
const CLAIMED = "2026-11-23T10:00:00.000Z";

const target = (
  id: string,
  findingId: string,
  claimed = true,
  path = "src/a.ts",
): RecheckEntry => ({
  id,
  findingId,
  fingerprint: `fp-${findingId}`,
  path,
  ruleCategory: "correctness",
  severity: "should_fix",
  ...(claimed ? { fixClaimedAt: CLAIMED } : {}),
});

const verdict = (id: string, confirmed: boolean) => ({
  id,
  confirmed,
  reason: confirmed ? "Still there." : "The guard handles it now.",
});

describe("settledFixClaims", () => {
  const targets = [
    target("F1", "f1"),
    target("F2", "f2"),
    target("F3", "f3"),
    target("F4", "f4", true, "src/unreviewed.ts"),
    target("F5", "f5"),
    target("F6", "f6", false),
  ];
  const settled = settledFixClaims(
    targets,
    [
      // Closed by the plan.
      verdict("F1", false),
      // "Fixed", but the plan didn't close it (its file wasn't reviewed, say): kept.
      verdict("F2", false),
      // Still there, on a file the review read: settled.
      verdict("F3", true),
      // Still there, but its file wasn't read: kept.
      verdict("F4", true),
      // F5 got no verdict: kept. F6 has no claim.
      verdict("F6", true),
    ],
    new Set(["f1"]),
    (entry) => entry.path !== "src/unreviewed.ts",
  );

  it("settles only claims closed, or confirmed on a file the review read", () => {
    expect(settled).toEqual(["f1", "f3"]);
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
