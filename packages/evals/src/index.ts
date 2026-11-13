/**
 * @lgtmoose/evals: runs the review pipeline on fixtures (a repo snapshot with seeded bugs, or a
 * clean change) and scores what it would post: recall on seeded bugs, false positives on clean
 * changes, severity accuracy, cost and time. CI gates prompt, rule pack and harness changes on
 * recall against a stored baseline.
 */
export {
  buildFixtureRepo,
  expectedFindingSchema,
  fixtureSpecSchema,
  loadFixtures,
  mustNotFlagSchema,
  type ExpectedFinding,
  type Fixture,
  type FixtureRepo,
  type FixtureSpec,
  type MustNotFlag,
} from "./fixture.js";
export {
  hitsMustNotFlag,
  matchesExpected,
  scoreFixture,
  totals,
  type EvalTotals,
  type FixtureRun,
  type FixtureScore,
} from "./score.js";
export {
  RECALL_TOLERANCE,
  REPORT_MARKER,
  baselineFrom,
  baselineSchema,
  buildReport,
  checkBaseline,
  readBaseline,
  renderMarkdown,
  type Baseline,
  type EvalReport,
  type GateResult,
} from "./report.js";
export { runFixture, runFixtures, type RunOptions } from "./run.js";
