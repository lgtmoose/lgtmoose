import { inline } from "@lgtmoose/summary";
import { learningTotals, type ScenarioScore } from "./learning.js";

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** What a scenario's reviews came to, as one short cell. */
function rounds(score: ScenarioScore): string {
  return score.rounds
    .map((round) => {
      if (round.error !== undefined) return "failed";
      return round.raised ? "raised" : "quiet";
    })
    .join(" → ");
}

function learned(score: ScenarioScore): string {
  if (score.notApplicable) return "n/a (not raised first)";
  if (score.expect === "holds") return score.learnedAfter === undefined ? "held" : "**taught away**";
  if (score.learnedAfter === undefined) return "**never**";
  const late = score.learnedAfter > score.signals ? " (late)" : "";
  return `${score.learnedAfter} of ${score.signals}${late}`;
}

/**
 * The learning-speed section of the evals report, for the PR comment and the job summary.
 * Scenario names are escaped; the correction outcomes are the policy's own words.
 */
export function renderLearningMarkdown(
  scores: readonly ScenarioScore[],
  gate: { ok: boolean; message: string },
  model?: string,
): string {
  const totals = learningTotals(scores);
  const lines = [
    "## Learning speed",
    "",
    `${gate.ok ? "✅" : "❌"} ${gate.message}`,
    "",
    `A correction (a \`learn:\`, a decline and \`remember\`, or repeated rejections) is applied after each review that raises a scenario's finding, and the next PR shows whether it stuck${model === undefined ? "" : `. Reviewer: ${inline(model)}`}.`,
    "",
    "| Score | Value |",
    "| --- | --- |",
    `| Repeat after correction | ${percent(totals.repeatRate)} (${totals.repeats} of ${totals.repeatChances}) |`,
    `| Collateral in protected categories | ${percent(totals.collateralRate)} (${totals.collateral} of ${totals.protectedChecked}) |`,
    `| Other kept findings quieted | ${totals.overreach} |`,
    `| Untrusted learnings in prompts | ${totals.untrustedInPrompt} |`,
    `| Mean signals to learn | ${totals.meanTimeToLearn === undefined ? "–" : Math.round(totals.meanTimeToLearn * 10) / 10} |`,
    `| Scenarios | ${totals.scenarios}${totals.notApplicable > 0 ? `, ${totals.notApplicable} not applicable` : ""}${totals.failedRuns > 0 ? `, ${totals.failedRuns} with failed reviews` : ""} |`,
    "",
    "| Scenario | Family | Correction | Reviews | Learned after | What the corrections did |",
    "| --- | --- | --- | --- | --- | --- |",
    ...scores.map(
      (score) =>
        `| ${inline(score.name)} | ${score.family} | ${score.correction} | ${rounds(score)} | ${learned(score)} | ${inline(score.outcomes.join("; ") || "–")} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
