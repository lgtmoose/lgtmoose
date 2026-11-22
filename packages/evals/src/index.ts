/**
 * @lgtmoose/evals: runs the review pipeline on fixtures (a repo snapshot with seeded bugs, or a
 * clean change) and scores what it would post: recall on seeded bugs, false positives on clean
 * changes, severity accuracy, cost and time. CI gates prompt, rule pack and harness changes on
 * recall against a stored baseline. The learning-speed family (`learning/`) checks that a
 * correction sticks on the next review, and that none quiets a protected-category finding.
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
  REPEAT_TOLERANCE,
  checkLearning,
  follows,
  gullibleReviewer,
  isFinding,
  learningTotals,
  loadScenarios,
  promptLearnings,
  runScenario,
  runScenarios,
  scenarioFindingSchema,
  scenarioProblems,
  scenarioSpecSchema,
  type LearningRound,
  type LearningRunOptions,
  type LearningTotals,
  type Scenario,
  type ScenarioFinding,
  type ScenarioScore,
  type ScenarioSpec,
} from "./learning.js";
export { renderLearningMarkdown } from "./learning-report.js";
export {
  loadRecheckScenarios,
  recheckScenarioSchema,
  recheckTotals,
  renderRecheckMarkdown,
  runRecheckScenario,
  runRecheckScenarios,
  type RecheckRunOptions,
  type RecheckScenario,
  type RecheckScore,
  type RecheckTotals,
} from "./recheck.js";
export { checkLearningBaseline, type LearningReport } from "./report.js";
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
