import type { Finding } from "@lgtmoose/core";
import type { ExpectedFinding, Fixture, MustNotFlag } from "./fixture.js";

/** The lines a finding cites on the head side: [start, end], both included. */
function findingRange(finding: Finding): [number, number] {
  const start = finding.start_line ?? finding.line;
  return [Math.min(start, finding.line), Math.max(start, finding.line)];
}

function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

function categories(expected: ExpectedFinding): readonly string[] {
  return typeof expected.category === "string" ? [expected.category] : expected.category;
}

/**
 * Whether a finding reports an expected problem: same path, a cited range on the head side that
 * overlaps the expected lines, and one of its categories. Severity is scored separately.
 */
export function matchesExpected(finding: Finding, expected: ExpectedFinding): boolean {
  return (
    finding.side === "RIGHT" &&
    finding.path === expected.path &&
    overlaps(findingRange(finding), expected.lines) &&
    categories(expected).includes(finding.rule_category)
  );
}

/** Whether a finding lands on code a must-not-flag assertion protects. Nits never count. */
export function hitsMustNotFlag(finding: Finding, rule: MustNotFlag): boolean {
  if (finding.severity === "nit" || finding.path !== rule.path) return false;
  if (rule.categories !== undefined && !rule.categories.includes(finding.rule_category)) {
    return false;
  }
  return (
    rule.lines === undefined ||
    (finding.side === "RIGHT" && overlaps(findingRange(finding), rule.lines))
  );
}

/** What one fixture's run produced, before scoring. */
export interface FixtureRun {
  /** Every finding the run would post: inline and in the review body. */
  findings: readonly Finding[];
  costUsd: number;
  durationMs: number;
  /** Batches that failed, or the error that stopped the run. */
  errors: readonly string[];
}

export interface FixtureScore {
  name: string;
  kind: Fixture["kind"];
  expected: number;
  /** Expected problems some finding reported, each with the finding that reported it. */
  matched: { expected: ExpectedFinding; finding: Finding }[];
  /** Matched findings whose severity is the expected one. */
  severityCorrect: number;
  missed: ExpectedFinding[];
  /**
   * False positives: findings on code a must-not-flag assertion protects, and on a clean
   * fixture every blocking or should-fix finding.
   */
  falsePositives: Finding[];
  /** Other findings on a seeded fixture: not expected, not forbidden. Listed for review. */
  unexpected: Finding[];
  costUsd: number;
  durationMs: number;
  errors: readonly string[];
}

/**
 * Scores one run against its fixture. Each expected problem is matched by at most one finding,
 * and each finding matches at most one expected problem, in the fixture's order.
 */
export function scoreFixture(fixture: Fixture, run: FixtureRun): FixtureScore {
  const unused = new Set(run.findings);
  const matched: FixtureScore["matched"] = [];
  const missed: ExpectedFinding[] = [];
  for (const expected of fixture.expected) {
    const finding = [...unused].find((candidate) => matchesExpected(candidate, expected));
    if (finding === undefined) {
      missed.push(expected);
      continue;
    }
    unused.delete(finding);
    matched.push({ expected, finding });
  }
  const falsePositives: Finding[] = [];
  const unexpected: Finding[] = [];
  for (const finding of unused) {
    const forbidden = fixture.mustNotFlag.some((rule) => hitsMustNotFlag(finding, rule));
    const onClean = fixture.kind === "clean" && finding.severity !== "nit";
    if (forbidden || onClean) falsePositives.push(finding);
    else unexpected.push(finding);
  }
  return {
    name: fixture.name,
    kind: fixture.kind,
    expected: fixture.expected.length,
    matched,
    severityCorrect: matched.filter((m) => m.finding.severity === m.expected.severity).length,
    missed,
    falsePositives,
    unexpected,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    errors: run.errors,
  };
}

export interface EvalTotals {
  /** Expected problems found, out of all expected problems on seeded fixtures. */
  recall: number;
  /** Clean fixtures with at least one false positive, out of all clean fixtures. */
  falsePositiveRate: number;
  /** Matched findings with the expected severity, out of all matched findings. */
  severityAccuracy: number;
  expected: number;
  found: number;
  falsePositives: number;
  costUsd: number;
  durationMs: number;
  /** Fixtures whose run had a failed batch or failed outright. */
  failedRuns: number;
}

/**
 * Totals over all fixtures. A rate with nothing to measure (no seeded fixtures, no clean ones,
 * nothing matched) is 1 for recall and severity accuracy and 0 for the false-positive rate, so
 * an empty set never fails a gate on its own.
 */
export function totals(scores: readonly FixtureScore[]): EvalTotals {
  const seeded = scores.filter((s) => s.kind === "seeded");
  const clean = scores.filter((s) => s.kind === "clean");
  const expected = seeded.reduce((n, s) => n + s.expected, 0);
  const found = seeded.reduce((n, s) => n + s.matched.length, 0);
  const matchedAll = scores.reduce((n, s) => n + s.matched.length, 0);
  const severityCorrect = scores.reduce((n, s) => n + s.severityCorrect, 0);
  const flaggedClean = clean.filter((s) => s.falsePositives.length > 0).length;
  return {
    recall: expected === 0 ? 1 : found / expected,
    falsePositiveRate: clean.length === 0 ? 0 : flaggedClean / clean.length,
    severityAccuracy: matchedAll === 0 ? 1 : severityCorrect / matchedAll,
    expected,
    found,
    falsePositives: scores.reduce((n, s) => n + s.falsePositives.length, 0),
    costUsd: scores.reduce((n, s) => n + s.costUsd, 0),
    durationMs: scores.reduce((n, s) => n + s.durationMs, 0),
    failedRuns: scores.filter((s) => s.errors.length > 0).length,
  };
}
