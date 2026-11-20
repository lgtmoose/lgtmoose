import type { Finding } from "@lgtmoose/core";
import type { ExpectedFinding, Fixture, MustNotFlag } from "./fixture.js";

/** The lines a finding cites, on its side: [start, end], both included. */
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
 * Whether a finding reports an expected problem: same path and side, a cited range that overlaps
 * the expected lines, and one of its categories. Severity is scored separately.
 */
export function matchesExpected(finding: Finding, expected: ExpectedFinding): boolean {
  return (
    finding.side === expected.side &&
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
  tags: readonly string[];
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
  /**
   * Set when the fixture ran more than once. One entry per expected finding, in the first run's
   * order: how many of the runs reported it. The score's own matched and missed stay the first run,
   * so a baseline still compares one run.
   */
  hitRates?: FindingHitRate[];
}

/** How often one expected finding was reported across repeated runs of one fixture. */
export interface FindingHitRate {
  path: string;
  lines: readonly [number, number];
  note?: string;
  hits: number;
  runs: number;
}

/**
 * Pairs expected problems with findings so that as many as possible are matched, each finding
 * used once (augmenting paths; fixtures are small). Greedy first-come matching could give a
 * finding to one problem when it was the only match for another. Returns the finding for each
 * expected problem, by index, or undefined.
 */
function bestAssignment(
  expected: readonly ExpectedFinding[],
  findings: readonly Finding[],
): (Finding | undefined)[] {
  const candidates = expected.map((e) =>
    findings.flatMap((finding, j) => (matchesExpected(finding, e) ? [j] : [])),
  );
  const owner = new Map<number, number>();
  const tryAssign = (i: number, seen: Set<number>): boolean => {
    for (const j of candidates[i] ?? []) {
      if (seen.has(j)) continue;
      seen.add(j);
      const current = owner.get(j);
      if (current === undefined || tryAssign(current, seen)) {
        owner.set(j, i);
        return true;
      }
    }
    return false;
  };
  expected.forEach((_, i) => tryAssign(i, new Set()));
  const result: (Finding | undefined)[] = expected.map(() => undefined);
  for (const [j, i] of owner) result[i] = findings[j];
  return result;
}

/**
 * Scores one run against its fixture. Each expected problem is matched by at most one finding,
 * and each finding matches at most one expected problem, matching as many as possible.
 */
export function scoreFixture(fixture: Fixture, run: FixtureRun): FixtureScore {
  const assigned = bestAssignment(fixture.expected, run.findings);
  const unused = new Set(run.findings);
  const matched: FixtureScore["matched"] = [];
  const missed: ExpectedFinding[] = [];
  fixture.expected.forEach((expected, i) => {
    const finding = assigned[i];
    if (finding === undefined) {
      missed.push(expected);
      return;
    }
    unused.delete(finding);
    matched.push({ expected, finding });
  });
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
    tags: fixture.tags,
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

function expectedKey(expected: ExpectedFinding): string {
  const category = Array.isArray(expected.category)
    ? expected.category.join(",")
    : expected.category;
  return `${category}:${expected.side}:${expected.path}:${expected.lines[0]}-${expected.lines[1]}`;
}

/**
 * How often each expected finding of the first run was reported across `runs` (the first run
 * included). Empty unless there is more than one run.
 */
export function findingHitRates(runs: readonly FixtureScore[]): FindingHitRate[] {
  const first = runs[0];
  if (first === undefined || runs.length < 2) return [];
  const expected = [...first.matched.map((match) => match.expected), ...first.missed];
  return expected.map((item) => {
    const key = expectedKey(item);
    const hits = runs.filter((run) =>
      run.matched.some((match) => expectedKey(match.expected) === key),
    ).length;
    return {
      path: item.path,
      lines: item.lines,
      ...(item.note === undefined ? {} : { note: item.note }),
      hits,
      runs: runs.length,
    };
  });
}

/**
 * The first run's findings, so a baseline still compares one run, with the cost, time and errors
 * of every run. Hit rates are set when there is more than one run.
 */
export function combineRepeatedRuns(runs: readonly FixtureScore[]): FixtureScore | undefined {
  const first = runs[0];
  if (first === undefined) return undefined;
  if (runs.length < 2) return first;
  return {
    ...first,
    costUsd: runs.reduce((sum, run) => sum + run.costUsd, 0),
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    errors: runs.flatMap((run) => run.errors),
    hitRates: findingHitRates(runs),
  };
}

/** Recall per tag, over the seeded fixtures with that tag, sorted by tag. */
export function recallByTag(
  scores: readonly FixtureScore[],
): { tag: string; found: number; expected: number }[] {
  const byTag = new Map<string, { found: number; expected: number }>();
  for (const score of scores) {
    if (score.kind !== "seeded") continue;
    for (const tag of score.tags) {
      const entry = byTag.get(tag) ?? { found: 0, expected: 0 };
      entry.found += score.matched.length;
      entry.expected += score.expected;
      byTag.set(tag, entry);
    }
  }
  return [...byTag]
    .sort(([a], [b]) => Number(a > b) - Number(a < b))
    .map(([tag, counts]) => ({ tag, ...counts }));
}
