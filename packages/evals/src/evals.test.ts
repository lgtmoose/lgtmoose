import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "@lgtmoose/core";
import { HarnessError, type Harness, type HarnessRunOptions } from "@lgtmoose/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureSpecSchema, loadFixtures, type Fixture } from "./fixture.js";
import {
  RECALL_TOLERANCE,
  REPORT_MARKER,
  buildReport,
  checkBaseline,
  renderMarkdown,
  type Baseline,
} from "./report.js";
import { runFixture, runFixtures } from "./run.js";
import { hitsMustNotFlag, matchesExpected, scoreFixture, totals } from "./score.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    rule_category: "correctness",
    severity: "blocking",
    path: "src/cart.ts",
    line: 10,
    side: "RIGHT",
    title: "Loop skips the last item",
    body: "The bound drops the last item.",
    evidence: "for (let i = 0; i < items.length - 1; i++) {",
    ...overrides,
  };
}

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    name: "f",
    dir: "/nowhere",
    title: "t",
    body: "",
    kind: "seeded",
    expected: [
      { category: "correctness", path: "src/cart.ts", lines: [10, 10], severity: "blocking" },
    ],
    mustNotFlag: [],
    deleted: [],
    ...overrides,
  };
}

const RUN = { costUsd: 0, durationMs: 0, errors: [] };

describe("fixtures", () => {
  it("loads the seeded fixtures", async () => {
    const fixtures = await loadFixtures(FIXTURES);
    expect(fixtures.map((f) => [f.name, f.kind])).toEqual([
      ["clean-rename", "clean"],
      ["missing-authz", "seeded"],
      ["off-by-one", "seeded"],
    ]);
  });

  it.each([
    [{ title: "t", kind: "seeded" }, "needs at least one expected finding"],
    [
      {
        title: "t",
        kind: "clean",
        expected: [{ category: "c", path: "a", lines: [1, 1], severity: "nit" }],
      },
      "can't expect findings",
    ],
    [{ title: "t", kind: "clean", deleted: ["../etc/passwd"] }, "without `..`"],
    [
      { title: "t", kind: "clean", mustNotFlag: [{ path: "a", lines: [5, 2] }] },
      "start can't be after",
    ],
  ])("rejects %j", (spec, message) => {
    const parsed = fixtureSpecSchema.safeParse(spec);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(message);
  });
});

describe("matching", () => {
  const expected = fixture().expected[0]!;

  it("needs the path, an overlapping range on the head side and a listed category", () => {
    expect(matchesExpected(finding(), expected)).toBe(true);
    expect(matchesExpected(finding({ start_line: 8, line: 12 }), expected)).toBe(true);
    expect(matchesExpected(finding({ line: 11 }), expected)).toBe(false);
    expect(matchesExpected(finding({ path: "src/other.ts" }), expected)).toBe(false);
    expect(matchesExpected(finding({ side: "LEFT" }), expected)).toBe(false);
    expect(matchesExpected(finding({ rule_category: "tests" }), expected)).toBe(false);
    expect(
      matchesExpected(finding({ rule_category: "security" }), {
        ...expected,
        category: ["authz", "security"],
      }),
    ).toBe(true);
  });

  it("flags must-not-flag hits, but never nits", () => {
    const rule = { path: "src/cart.ts", lines: [15, 15] as [number, number] };
    expect(hitsMustNotFlag(finding({ line: 15 }), rule)).toBe(true);
    expect(hitsMustNotFlag(finding({ line: 15, severity: "nit" }), rule)).toBe(false);
    expect(hitsMustNotFlag(finding({ line: 14 }), rule)).toBe(false);
    expect(hitsMustNotFlag(finding({ line: 99 }), { path: "src/cart.ts" })).toBe(true);
    expect(hitsMustNotFlag(finding(), { path: "src/cart.ts", categories: ["security"] })).toBe(
      false,
    );
  });
});

describe("scoring", () => {
  it("matches each expected problem once and sorts the rest", () => {
    const f = fixture({ mustNotFlag: [{ path: "src/cart.ts", lines: [15, 15] }] });
    const duplicate = finding({ severity: "should_fix" });
    const forbidden = finding({ line: 15, title: "Clamp hides bugs" });
    const other = finding({ path: "README.md", line: 1 });
    const score = scoreFixture(f, { ...RUN, findings: [finding(), duplicate, forbidden, other] });
    expect(score.matched.map((m) => m.finding)).toEqual([finding()]);
    expect(score.severityCorrect).toBe(1);
    expect(score.falsePositives).toEqual([forbidden]);
    expect(score.unexpected).toEqual([duplicate, other]);
  });

  it("counts blocking and should-fix findings on a clean fixture as false positives", () => {
    const clean = fixture({ kind: "clean", expected: [] });
    const score = scoreFixture(clean, {
      ...RUN,
      findings: [finding(), finding({ severity: "nit", line: 3 })],
    });
    expect(score.falsePositives).toEqual([finding()]);
    expect(score.unexpected).toHaveLength(1);
  });

  it("totals recall, false-positive rate, severity accuracy, cost and time", () => {
    const seeded = scoreFixture(
      fixture({
        expected: [
          { category: "correctness", path: "src/cart.ts", lines: [10, 10], severity: "blocking" },
          { category: "correctness", path: "src/cart.ts", lines: [20, 20], severity: "blocking" },
        ],
      }),
      {
        findings: [finding({ severity: "should_fix" })],
        costUsd: 0.5,
        durationMs: 1000,
        errors: [],
      },
    );
    const clean = scoreFixture(fixture({ kind: "clean", expected: [] }), {
      findings: [finding()],
      costUsd: 0.25,
      durationMs: 500,
      errors: ["batch 1: timeout"],
    });
    expect(totals([seeded, clean])).toEqual({
      recall: 0.5,
      falsePositiveRate: 1,
      severityAccuracy: 0,
      expected: 2,
      found: 1,
      falsePositives: 1,
      costUsd: 0.75,
      durationMs: 1500,
      failedRuns: 1,
    });
    expect(totals([])).toMatchObject({ recall: 1, falsePositiveRate: 0, severityAccuracy: 1 });
  });
});

describe("baseline gate", () => {
  const baseline: Baseline = {
    recall: 0.8,
    falsePositiveRate: 0,
    model: "sonnet",
    fixtures: 3,
    measuredAt: "2026-11-01T00:00:00.000Z",
  };
  const report = (recall: number) => ({
    ...buildReport([], "sonnet", new Date(0)),
    totals: { ...totals([]), recall },
  });

  it("allows recall within the tolerance and fails below it", () => {
    expect(checkBaseline(report(0.8 - RECALL_TOLERANCE), baseline).ok).toBe(true);
    expect(checkBaseline(report(0.7), baseline)).toEqual({
      ok: false,
      message: "Recall 70% is below the baseline's 80% (the gate allows down to 75%).",
    });
    expect(checkBaseline(report(0), undefined).ok).toBe(true);
  });

  it("renders a markdown report with the marker, escaped text and the details", () => {
    const score = scoreFixture(fixture({ name: "evil|name", kind: "clean", expected: [] }), {
      ...RUN,
      findings: [finding({ title: "<img src=x> @someone" })],
    });
    const markdown = renderMarkdown(buildReport([score], "sonnet", new Date(0)), baseline, {
      ok: true,
      message: "ok",
    });
    expect(markdown.startsWith(REPORT_MARKER)).toBe(true);
    expect(markdown).toContain("evil\\|name");
    expect(markdown).toContain("\\<img");
    expect(markdown).toContain("\\@\u2060someone");
    expect(markdown).toContain("false positive at src\\/cart\\.ts:10");
    expect(markdown).toContain("100% (+20 pts)");
    expect(markdown).toContain("100% (+100 pts)");
  });
});

describe("running fixtures", () => {
  let workRoot: string;
  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "lgtmoose-evals-test-"));
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  /** A model that reports the seeded bugs it's told about, by the path in the prompt. */
  function fakeHarness(answers: Record<string, Finding[]>, fail = false): Harness {
    return {
      id: "fake",
      run: async <T>(options: HarnessRunOptions<T>) => {
        if (fail) throw new HarnessError("auth", "No model credential found.");
        const findings = Object.entries(answers)
          .filter(([path]) => options.prompt.includes(`path="${path}"`))
          .flatMap(([, list]) => list);
        return {
          output: options.schema.parse({ findings }),
          transcriptKey: "t",
          usage: { costUsd: 0.1 },
        };
      },
    };
  }

  it("runs the real pipeline on every fixture and scores it", async () => {
    const fixtures = await loadFixtures(FIXTURES);
    const harness = fakeHarness({
      "src/cart.ts": [finding()],
      "src/routes/orders.ts": [
        finding({
          rule_category: "authz",
          path: "src/routes/orders.ts",
          start_line: 15,
          line: 18,
          title: "cancelOrder skips the ownership check",
          evidence:
            "export async function cancelOrder(db: Db, req: Request, res: Response): Promise<void> {",
        }),
      ],
      "src/receipt.ts": [
        finding({
          severity: "should_fix",
          path: "src/receipt.ts",
          line: 5,
          title: "Possible rounding",
          evidence: "return `${name.padEnd(20)} ${formatPrice(cents)}`;",
        }),
      ],
    });
    const scores = await runFixtures(fixtures, {
      harness,
      model: "fake",
      batchTimeoutMs: 1000,
      workRoot,
    });
    const t = totals(scores);
    expect(t).toMatchObject({
      recall: 1,
      falsePositiveRate: 1,
      severityAccuracy: 1,
      failedRuns: 0,
    });
    expect(t.costUsd).toBeCloseTo(0.3);
    expect(scores.find((s) => s.name === "clean-rename")?.falsePositives).toHaveLength(1);
  });

  it("scores a failed run as finding nothing, with the error", async () => {
    const [offByOne] = (await loadFixtures(FIXTURES)).filter((f) => f.name === "off-by-one");
    const score = await runFixture(offByOne!, {
      harness: fakeHarness({}, true),
      model: "fake",
      batchTimeoutMs: 1000,
      workRoot,
    });
    expect(score.matched).toEqual([]);
    expect(score.errors).toEqual(["batch 1: auth: No model credential found."]);
  });
});
