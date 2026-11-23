import { runKeys } from "@lgtmoose/pipeline";
import { describe, expect, it } from "vitest";
import type { ControlDeps } from "./ports.js";
import { clearFixClaims } from "./post.js";
import type { RecheckEntry } from "./recheck.js";

/**
 * Clearing the fix claims a run's recheck looked at (NIC-1140): only the targets it gave a
 * verdict on, so one the model skipped keeps its claim for the next run.
 */

const RUN = "4c1f8a2e-6b3d-4e5f-9a7b-1c2d3e4f5a6b";
const CLAIMED = "2026-11-23T10:00:00.000Z";

const target = (id: string, findingId: string, claimed = true): RecheckEntry => ({
  id,
  findingId,
  fingerprint: `fp-${findingId}`,
  path: "src/a.ts",
  ruleCategory: "correctness",
  severity: "should_fix",
  ...(claimed ? { fixClaimedAt: CLAIMED } : {}),
});

function setup(output: unknown) {
  const cleared: { findingId: string; fixClaimedAt: string }[][] = [];
  const logs: string[] = [];
  const deps = {
    store: {
      async getText(key: string) {
        return key === runKeys(RUN).batchOutput(4) && output !== undefined
          ? JSON.stringify(output)
          : undefined;
      },
    },
    findings: {
      async clearFixClaims(claims: readonly { findingId: string; fixClaimedAt: string }[]) {
        cleared.push([...claims]);
      },
    },
    log: (message: string, fields?: unknown) => logs.push(`${message} ${JSON.stringify(fields)}`),
  } as unknown as ControlDeps;
  const manifest = {
    recheck: {
      index: 4,
      sinceSha: "a".repeat(40),
      changed: ["src/a.ts"],
      targets: [target("F1", "f1"), target("F2", "f2"), target("F3", "f3", false)],
    },
  } as unknown as Parameters<typeof clearFixClaims>[2];
  return { deps, manifest, cleared, logs };
}

const verdict = (id: string) => ({ id, confirmed: false, reason: "The guard handles it now." });

describe("clearFixClaims", () => {
  it("clears only the claims of targets the recheck gave a verdict on", async () => {
    const { deps, manifest, cleared, logs } = setup({
      version: 1,
      index: 4,
      verdicts: [verdict("F1"), verdict("F3")],
      transcriptKeys: [],
    });
    await clearFixClaims(deps, RUN, manifest);
    // F2 had no verdict: its claim stays. F3 had a verdict but no claim.
    expect(logs).toEqual([]);
    expect(cleared).toEqual([[{ findingId: "f1", fixClaimedAt: CLAIMED }]]);
  });

  it("clears nothing when the recheck gave no readable verdicts", async () => {
    const { deps, manifest, cleared } = setup(undefined);
    await clearFixClaims(deps, RUN, manifest);
    expect(cleared).toEqual([]);
  });
});
