import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Harness, HarnessRunOptions } from "@lgtmoose/harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadRecheckScenarios,
  recheckTotals,
  renderRecheckMarkdown,
  runRecheckScenarios,
  type RecheckScenario,
} from "./recheck.js";

const SCENARIOS = fileURLToPath(new URL("../recheck", import.meta.url));

/**
 * A recheck with no model that answers each finding from the diff in its prompt: "fixed" when
 * the diff has `fix`, naming the file the diff changes when `names` is set. It stands in for the
 * model so CI checks the plumbing: the finding is picked, the prompt carries the change, and the
 * verdict goes through `fixedByRecheck`.
 */
function stubRecheck(
  fix: (prompt: string) => boolean,
  names: boolean,
): Harness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "stub-recheck",
    prompts,
    run: async <T>(options: HarnessRunOptions<T>) => {
      prompts.push(options.prompt);
      const file = /\+\+\+ b\/(\S+)/.exec(options.prompt)?.[1] ?? "";
      const fixed = fix(options.prompt);
      let reason = "The cited code still has the problem.";
      if (fixed) {
        reason = names
          ? `${file} now handles it before the cited code runs.`
          : "This looks handled now.";
      }
      return {
        output: options.schema.parse({ verdicts: [{ id: "F1", confirmed: !fixed, reason }] }),
        transcriptKey: "stub",
        usage: { costUsd: 0 },
      };
    },
  };
}

describe("the recheck scenarios", () => {
  let workRoot: string;
  let scenarios: RecheckScenario[];

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "lgtmoose-recheck-evals-"));
    scenarios = await loadRecheckScenarios(SCENARIOS);
  });

  afterAll(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it("has fixed and holding cases, protected categories among both", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
    expect(scenarios.some((s) => s.expect === "fixed")).toBe(true);
    expect(scenarios.some((s) => s.expect === "holds")).toBe(true);
  });

  it("picks each finding, sends its change, and scores a right answer as right", async () => {
    // Fixed where the later commit really fixes it: the router mounts requireAdmin, the
    // payment section turns the saved card into a token.
    const harness = stubRecheck(
      (prompt) => /\+.*requireAdmin\(exportUsers\)|\+.*tokenForSavedCard\(card/.test(prompt),
      true,
    );
    const scores = await runRecheckScenarios(scenarios, {
      harness,
      model: "stub",
      timeoutMs: 5_000,
      workRoot,
    });
    expect(scores.every((score) => score.checked && score.error === undefined)).toBe(true);
    expect(recheckTotals(scores)).toMatchObject({
      scenarios: scenarios.length,
      correct: scenarios.length,
      falseCloses: 0,
    });
    // The fix is in another file: the prompt carries that file's diff and the cited code.
    const savedCard = harness.prompts.find((prompt) => prompt.includes("tokenForSavedCard(card"));
    expect(savedCard).toContain("+++ b/src/checkout/PaymentSection.ts");
    expect(savedCard).toContain('<untrusted source="code" path="src/checkout/pay.ts"');
    expect(renderRecheckMarkdown(scores, "stub")).toContain("False closes: 0.");
  }, 120_000);

  it("keeps a protected finding open on a verdict that doesn't name its fix", async () => {
    const said = stubRecheck(() => true, false);
    const scores = await runRecheckScenarios(
      scenarios.filter(
        (s) => s.name === "export-guarded-by-router" || s.name === "tenant-filter-still-missing",
      ),
      { harness: said, model: "stub", timeoutMs: 5_000, workRoot },
    );
    expect(scores.map((score) => score.closed)).toEqual([false, false]);
    expect(scores.some((score) => score.falseClose)).toBe(false);
  }, 60_000);

  it("counts a run with no verdict for the finding as broken, not as a right holds", async () => {
    const silent: Harness = {
      id: "silent",
      run: async <T>(options: HarnessRunOptions<T>) => ({
        output: options.schema.parse({
          verdicts: [{ id: "F9", confirmed: true, reason: "Some other finding." }],
        }),
        transcriptKey: "silent",
        usage: { costUsd: 0 },
      }),
    };
    const scores = await runRecheckScenarios(
      scenarios.filter((s) => s.name === "saved-card-still-ignored"),
      { harness: silent, model: "stub", timeoutMs: 5_000, workRoot },
    );
    expect(scores[0]).toMatchObject({ closed: false, error: "the recheck gave no verdict for F1" });
    expect(recheckTotals(scores)).toMatchObject({ correct: 0, failed: 1 });
  }, 60_000);

  it("counts a finding closed though it still holds as a false close", async () => {
    const scores = await runRecheckScenarios(
      scenarios.filter((s) => s.name === "saved-card-still-ignored"),
      { harness: stubRecheck(() => true, true), model: "stub", timeoutMs: 5_000, workRoot },
    );
    expect(recheckTotals(scores)).toMatchObject({ falseCloses: 1 });
    expect(renderRecheckMarkdown(scores, "stub")).toContain("**closed, but it still holds**");
  }, 60_000);
});
