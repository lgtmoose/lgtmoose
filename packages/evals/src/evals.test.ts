import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "@lgtmoose/core";
import { HarnessError, type Harness, type HarnessRunOptions } from "@lgtmoose/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureProblems, fixtureSpecSchema, loadFixtures, type Fixture } from "./fixture.js";
import {
  RECALL_TOLERANCE,
  REPORT_MARKER,
  buildReport,
  checkBaseline,
  renderMarkdown,
  type Baseline,
} from "./report.js";
import { runFixture, runFixtures } from "./run.js";
import {
  combineRepeatedRuns,
  findingHitRates,
  hitsMustNotFlag,
  matchesExpected,
  recallByTag,
  scoreFixture,
  totals,
} from "./score.js";

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
      {
        category: "correctness",
        path: "src/cart.ts",
        lines: [10, 10],
        side: "RIGHT",
        severity: "blocking",
      },
    ],
    mustNotFlag: [],
    deleted: [],
    tags: [],
    ...overrides,
  };
}

const RUN = { costUsd: 0, durationMs: 0, errors: [] };

describe("fixtures", () => {
  it("loads the golden fixtures: at least 15 seeded and 5 clean", async () => {
    const fixtures = await loadFixtures(FIXTURES);
    const seeded = fixtures.filter((f) => f.kind === "seeded");
    const clean = fixtures.filter((f) => f.kind === "clean");
    expect(seeded.length).toBeGreaterThanOrEqual(15);
    expect(clean.length).toBeGreaterThanOrEqual(5);
    // The bug classes the golden set has to cover.
    const names = fixtures.map((f) => f.name);
    for (const name of [
      "tenant-filter-missing",
      "missing-auth-middleware",
      "cents-vs-dollars",
      "double-charge-on-retry",
      "unused-new-export",
      "env-var-undefined",
      "ci-wrong-working-directory",
      "nosql-operator-injection",
      "nested-ternary-nit",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).toEqual([...names].sort());
  });

  it("finds no mistakes in any fixture", async () => {
    // loadFixtures stops at the first bad fixture; this lists every problem at once.
    const problems: string[] = [];
    for (const entry of await readdir(FIXTURES, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(FIXTURES, entry.name);
      const spec = fixtureSpecSchema.parse(
        JSON.parse(await readFile(join(dir, "fixture.json"), "utf8")),
      );
      for (const problem of await fixtureProblems({ ...spec, name: entry.name, dir })) {
        problems.push(`${entry.name}: ${problem}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("tags the cross-file bugs", async () => {
    const fixtures = await loadFixtures(FIXTURES);
    const crossFile = fixtures.filter((f) => f.tags.includes("cross-file")).map((f) => f.name);
    expect(crossFile).toEqual([
      "ci-wrong-working-directory",
      "env-var-undefined",
      "saved-card-ignored",
      "unused-new-export",
    ]);
  });

  describe("checks", () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "lgtmoose-fixture-checks-"));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    async function write(name: string, spec: object, files: Record<string, string>) {
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(root, name, path, ".."), { recursive: true });
        await writeFile(join(root, name, path), text);
      }
      await writeFile(join(root, name, "fixture.json"), JSON.stringify(spec));
    }

    it.each([
      ["a range past the end of the file", { lines: [3, 4] }, "is past the file's last line"],
      ["a file that isn't there", { path: "src/missing.ts" }, "isn't in the head"],
      [
        "a file the PR doesn't change",
        { path: "src/same.ts", lines: [1, 1] },
        "isn't changed by the PR",
      ],
    ])("rejects %s", async (_, change, message) => {
      await write(
        "bad",
        {
          title: "t",
          kind: "seeded",
          expected: [
            {
              category: "correctness",
              path: "src/a.ts",
              lines: [1, 2],
              severity: "blocking",
              ...change,
            },
          ],
        },
        { "base/src/a.ts": "one\ntwo\n", "head/src/a.ts": "one\n2\n", "base/src/same.ts": "x\n" },
      );
      await expect(loadFixtures(root)).rejects.toThrow(message);
    });

    it("loads fixtures from several directories and refuses a name in two", async () => {
      const other = join(root, "private");
      await mkdir(other);
      await cp(join(FIXTURES, "off-by-one"), join(other, "private-off-by-one"), {
        recursive: true,
      });
      const both = await loadFixtures([FIXTURES, other]);
      expect(both.map((f) => f.name)).toContain("private-off-by-one");
      await cp(join(FIXTURES, "off-by-one"), join(other, "off-by-one"), { recursive: true });
      await expect(loadFixtures([FIXTURES, other])).rejects.toThrow("names must be unique");
      await expect(loadFixtures(join(root, "nope"))).rejects.toThrow("doesn't exist");
    });
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

  it("matches a removed line on the base side", () => {
    const removed = { ...expected, side: "LEFT" as const, lines: [12, 12] as [number, number] };
    expect(matchesExpected(finding({ side: "LEFT", line: 12 }), removed)).toBe(true);
    expect(matchesExpected(finding({ line: 12 }), removed)).toBe(false);
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

describe("recall by tag", () => {
  it("adds up seeded fixtures per tag and ignores clean ones", () => {
    const seeded = scoreFixture(fixture({ name: "a", tags: ["cross-file"] }), {
      ...RUN,
      findings: [],
    });
    const found = scoreFixture(fixture({ name: "b", tags: ["cross-file", "money"] }), {
      ...RUN,
      findings: [finding()],
    });
    const clean = scoreFixture(
      fixture({ name: "c", kind: "clean", expected: [], tags: ["money"] }),
      {
        ...RUN,
        findings: [],
      },
    );
    expect(recallByTag([seeded, found, clean])).toEqual([
      { tag: "cross-file", found: 1, expected: 2 },
      { tag: "money", found: 1, expected: 1 },
    ]);
    const markdown = renderMarkdown(
      buildReport([seeded, found], "sonnet", new Date(0)),
      undefined,
      {
        ok: true,
        message: "ok",
      },
    );
    expect(markdown).toContain("Recall by tag: cross\\-file 1/2 (50%), money 1/1 (100%).");
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

  it("matches as many expected problems as possible when their ranges overlap", () => {
    const wide = {
      category: "correctness",
      path: "src/cart.ts",
      lines: [10, 14] as [number, number],
      side: "RIGHT" as const,
      severity: "blocking" as const,
    };
    const narrow = { ...wide, lines: [12, 12] as [number, number] };
    const f = fixture({ expected: [wide, narrow] });
    // Greedy matching would give the line-12 finding to `wide` and leave `narrow` unmatched.
    const at12 = finding({ line: 12 });
    const at10 = finding({ line: 10 });
    const score = scoreFixture(f, { ...RUN, findings: [at12, at10] });
    expect(score.missed).toEqual([]);
    expect(score.matched.map((m) => m.finding)).toEqual([at10, at12]);
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
          {
            category: "correctness",
            path: "src/cart.ts",
            lines: [10, 10],
            side: "RIGHT",
            severity: "blocking",
          },
          {
            category: "correctness",
            path: "src/cart.ts",
            lines: [20, 20],
            side: "RIGHT",
            severity: "blocking",
          },
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

  it("counts how often a repeated run reports each expected finding, and ignores a single run", () => {
    const spec = fixture({
      expected: [
        {
          category: "correctness",
          path: "src/cart.ts",
          lines: [10, 10],
          side: "RIGHT",
          severity: "blocking",
          note: "the bug",
        },
      ],
    });
    const hit = scoreFixture(spec, {
      findings: [finding()],
      costUsd: 0.1,
      durationMs: 1,
      errors: [],
    });
    const miss = scoreFixture(spec, { findings: [], costUsd: 0.1, durationMs: 1, errors: [] });
    expect(findingHitRates([hit])).toEqual([]);
    expect(findingHitRates([hit, miss, hit])).toEqual([
      {
        path: "src/cart.ts",
        lines: [10, 10],
        note: "the bug",
        hits: 2,
        runs: 3,
      },
    ]);
    const report = renderMarkdown(
      buildReport([{ ...hit, hitRates: findingHitRates([hit, miss]) }], "sonnet", new Date(0)),
      undefined,
      { ok: true, message: "ok" },
    );
    expect(report).toContain("1 of 2");
    expect(report).toContain("the first run only");
    expect(report).toContain("cost and time are every run");
  });

  it("keeps findings at the same lines apart, and adds up every run's cost and errors", () => {
    const spec = fixture({
      expected: [
        {
          category: "correctness",
          path: "src/cart.ts",
          lines: [10, 10],
          side: "RIGHT",
          severity: "blocking",
          note: "the bug",
        },
        {
          category: "security",
          path: "src/cart.ts",
          lines: [10, 10],
          side: "RIGHT",
          severity: "should_fix",
          note: "the other bug",
        },
      ],
    });
    const both = scoreFixture(spec, {
      findings: [finding(), finding({ rule_category: "security", severity: "should_fix" })],
      costUsd: 0.2,
      durationMs: 2,
      errors: [],
    });
    const onlyFirst = scoreFixture(spec, {
      findings: [finding()],
      costUsd: 0.3,
      durationMs: 4,
      errors: ["the second run failed"],
    });
    expect(findingHitRates([both, onlyFirst]).map((rate) => [rate.note, rate.hits])).toEqual([
      ["the bug", 2],
      ["the other bug", 1],
    ]);
    expect(combineRepeatedRuns([both, onlyFirst])).toMatchObject({
      matched: both.matched,
      costUsd: 0.5,
      durationMs: 6,
      errors: ["the second run failed"],
    });
    expect(combineRepeatedRuns([both])).toBe(both);
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

  it("puts every golden bug in a reviewed batch, on lines the diff shows", async () => {
    const fixtures = await loadFixtures(FIXTURES);
    const problems: string[] = [];
    /** Answers each batch with a finding on every expected bug of the files it shows. */
    const perfect: Harness = {
      id: "perfect",
      run: async <T>(options: HarnessRunOptions<T>) => {
        const name = (options.runId ?? "").replace(/^evals-/, "").replace(/-batch-\d+$/, "");
        const fx = fixtures.find((f) => f.name === name);
        const findings: Finding[] = [];
        for (const e of fx?.expected ?? []) {
          const at = options.prompt.indexOf(`path="${e.path}"`);
          if (fx === undefined || at === -1) continue;
          // The file's diff block, up to the next file's.
          const next = options.prompt.indexOf(' path="', at + 1);
          const block = options.prompt.slice(at, next === -1 ? undefined : next);
          const label = `${e.side === "LEFT" ? "L" : "R"}${e.lines[0]} `;
          if (!block.includes(label))
            problems.push(`${fx.name}: ${e.path}:${e.lines[0]} isn't in the diff`);
          const side = e.side === "LEFT" ? ["base"] : ["head", "base"];
          let text = "";
          for (const dir of side) {
            text = await readFile(join(fx.dir, dir, e.path), "utf8").catch(() => "");
            if (text !== "") break;
          }
          const category = typeof e.category === "string" ? e.category : e.category[0];
          findings.push({
            rule_category: category ?? "correctness",
            severity: e.severity,
            path: e.path,
            line: e.lines[1],
            ...(e.lines[0] === e.lines[1] ? {} : { start_line: e.lines[0] }),
            side: e.side,
            title: "Seeded bug",
            body: e.note ?? "The seeded bug.",
            evidence: text
              .split("\n")
              .slice(e.lines[0] - 1, e.lines[1])
              .join("\n"),
          });
        }
        return { output: options.schema.parse({ findings }), transcriptKey: "t" };
      },
    };
    const scores = await runFixtures(fixtures, {
      harness: perfect,
      model: "fake",
      batchTimeoutMs: 1000,
      workRoot,
    });
    expect(problems).toEqual([]);
    const missed = scores.flatMap((score) => score.missed.map((m) => `${score.name}: ${m.path}`));
    expect(missed).toEqual([]);
    expect(totals(scores)).toMatchObject({ recall: 1, falsePositiveRate: 0, failedRuns: 0 });
  }, 120_000);

  it("runs the real pipeline on fixtures and scores them", async () => {
    const seeds = new Set(["clean-rename", "missing-authz", "off-by-one"]);
    const fixtures = (await loadFixtures(FIXTURES)).filter((f) => seeds.has(f.name));
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
    // Real clones of three fixtures: about a second alone, but over the 5 s default under load.
  }, 60_000);

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
