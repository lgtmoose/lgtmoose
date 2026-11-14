/**
 * @lgtmoose/evals: runs the review pipeline on fixtures (a repo snapshot with seeded bugs, or a
 * clean change) and scores what it would post: recall on seeded bugs, false positives on clean
 * changes, severity accuracy, cost and time. CI gates prompt, rule pack and harness changes on
 * recall against a stored baseline.
 */
export {
  buildFixtureRepo,
  expectedFindingSchema,
  fixtureProblems,
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
  recallByTag,
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
export {
  EVALUATED_ROLES,
  assignmentFromRoles,
  assignmentsFromProviders,
  limitHits,
  matrixAssignments,
  matrixRan,
  matrixResultsSchema,
  modelsFrom,
  renderMatrixMarkdown,
  runMatrix,
  type Assignment,
  type MatrixConfiguration,
  type MatrixOptions,
  type MatrixResults,
} from "./matrix.js";
export { EVAL_PROVIDERS, type EvalProvider, type HarnessSetup } from "./providers.js";
