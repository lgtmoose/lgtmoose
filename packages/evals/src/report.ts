import { readFile } from "node:fs/promises";
import { inline } from "@lgtmoose/summary";
import { z } from "zod";
import {
  REPEAT_TOLERANCE,
  checkLearning,
  type LearningTotals,
  type ScenarioScore,
} from "./learning.js";
import { recallByTag, totals, type EvalTotals, type FixtureScore } from "./score.js";

/** The marker the CI job finds its own PR comment by, to edit it instead of adding another. */
export const REPORT_MARKER = "<!-- lgtmoose-evals -->";

/**
 * How far recall may fall below the baseline before the gate fails. Model runs aren't
 * deterministic: on a small fixture set one seeded bug found or missed moves recall by several
 * points, so the gate allows that much noise and no more.
 */
export const RECALL_TOLERANCE = 0.05;

export const baselineSchema = z
  .object({
    recall: z.number().min(0).max(1),
    falsePositiveRate: z.number().min(0).max(1),
    /** Which model and fixtures it was measured with, and when. */
    model: z.string(),
    fixtures: z.number().int().min(0),
    measuredAt: z.string(),
    /**
     * The learning-speed family's repeat-after-correction rate, and the model it was measured
     * with. Left out until a model run measures it: then the rate isn't compared.
     */
    learningRepeatRate: z.number().min(0).max(1).optional(),
    learningModel: z.string().optional(),
  })
  .strict();

export type Baseline = z.infer<typeof baselineSchema>;

export async function readBaseline(path: string): Promise<Baseline | undefined> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return text === undefined ? undefined : baselineSchema.parse(JSON.parse(text));
}

export interface EvalReport {
  model: string;
  startedAt: string;
  totals: EvalTotals;
  fixtures: FixtureScore[];
  /** The learning-speed family's run (NIC-1082), when it ran. */
  learning?: LearningReport;
}

export interface LearningReport {
  model: string;
  totals: LearningTotals;
  scenarios: ScenarioScore[];
}

/**
 * The learning gate for a model run: collateral and untrusted learnings in prompts always fail
 * it; the repeat rate fails it when it's more than `REPEAT_TOLERANCE` above the baseline's.
 * Without a baseline rate, or with a model other than the one the baseline was measured with,
 * the rate isn't compared.
 */
export function checkLearningBaseline(
  learning: LearningReport,
  baseline: Baseline | undefined,
): GateResult {
  const comparable =
    baseline?.learningRepeatRate !== undefined &&
    (baseline.learningModel === undefined || baseline.learningModel === learning.model);
  const max = comparable ? (baseline.learningRepeatRate ?? 0) + REPEAT_TOLERANCE : 1;
  const { ok, problems } = checkLearning(learning.totals, max);
  if (!ok) return { ok, message: `The learning gate fails: ${problems.join("; ")}.` };
  const rate = percent(learning.totals.repeatRate);
  return {
    ok,
    message: comparable
      ? `Repeat after correction ${rate} against a baseline of ${percent(baseline.learningRepeatRate ?? 0)}; no collateral.`
      : `Repeat after correction ${rate} (no learning baseline for ${learning.model} yet); no collateral.`,
  };
}

export function buildReport(
  scores: readonly FixtureScore[],
  model: string,
  startedAt: Date,
): EvalReport {
  return {
    model,
    startedAt: startedAt.toISOString(),
    totals: totals(scores),
    fixtures: [...scores],
  };
}

export interface GateResult {
  ok: boolean;
  message: string;
}

/** Fails when recall is more than `RECALL_TOLERANCE` below the baseline's. */
export function checkBaseline(report: EvalReport, baseline: Baseline | undefined): GateResult {
  if (baseline === undefined) {
    return { ok: true, message: "No baseline yet: nothing to compare with." };
  }
  const floor = baseline.recall - RECALL_TOLERANCE;
  const recall = report.totals.recall;
  if (recall < floor) {
    return {
      ok: false,
      message: `Recall ${percent(recall)} is below the baseline's ${percent(baseline.recall)} (the gate allows down to ${percent(floor)}).`,
    };
  }
  return {
    ok: true,
    message: `Recall ${percent(recall)} against a baseline of ${percent(baseline.recall)}.`,
  };
}

/** A new baseline from a run, to commit when a change is meant to move the numbers. */
export function baselineFrom(report: EvalReport): Baseline {
  return {
    recall: report.totals.recall,
    falsePositiveRate: report.totals.falsePositiveRate,
    model: report.model,
    fixtures: report.fixtures.length,
    measuredAt: report.startedAt,
    ...(report.learning === undefined
      ? {}
      : {
          learningRepeatRate: report.learning.totals.repeatRate,
          learningModel: report.learning.model,
        }),
  };
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

function delta(value: number, base: number | undefined): string {
  if (base === undefined) return "";
  const diff = Math.round((value - base) * 1000) / 10;
  if (diff === 0) return " (±0)";
  return ` (${diff > 0 ? "+" : ""}${diff} pts)`;
}

function where(path: string, lines: readonly [number, number]): string {
  return `${inline(path)}:${lines[0] === lines[1] ? lines[0] : `${lines[0]}\\-${lines[1]}`}`;
}

/**
 * The report as Markdown, for the PR comment and the job summary. Fixture names, paths and
 * finding titles are escaped: a finding title is model output about fixture code.
 */
export function renderMarkdown(
  report: EvalReport,
  baseline: Baseline | undefined,
  gate: GateResult,
): string {
  const t = report.totals;
  // Severity accuracy is over matched findings; with none matched there's nothing to show.
  const matchedAny = report.fixtures.some((score) => score.matched.length > 0);
  const lines = [
    REPORT_MARKER,
    "## LGTMoose evals",
    "",
    `${gate.ok ? "✅" : "❌"} ${gate.message}`,
    "",
    "| Recall | False-positive rate | Severity accuracy | Cost | Time |",
    "| --- | --- | --- | --- | --- |",
    `| ${percent(t.recall)}${delta(t.recall, baseline?.recall)} | ${percent(t.falsePositiveRate)}${delta(t.falsePositiveRate, baseline?.falsePositiveRate)} | ${matchedAny ? percent(t.severityAccuracy) : "n/a"} | ${money(t.costUsd)} | ${seconds(t.durationMs)} |`,
    "",
    `${t.found} of ${t.expected} seeded problems found, ${t.falsePositives} false positives, ${report.fixtures.length} fixtures, model ${inline(report.model)}.`,
  ];
  if (t.failedRuns > 0) {
    lines.push(
      "",
      `⚠️ ${t.failedRuns} of ${report.fixtures.length} fixture runs had failures. They count as misses on seeded fixtures, and a clean fixture that didn't run can't show a false positive.`,
    );
  }
  const byTag = recallByTag(report.fixtures);
  if (byTag.length > 0) {
    const parts = byTag.map(
      ({ tag, found, expected }) =>
        `${inline(tag)} ${found}/${expected} (${percent(expected === 0 ? 1 : found / expected)})`,
    );
    lines.push("", `Recall by tag: ${parts.join(", ")}.`);
  }
  lines.push(
    "",
    "| Fixture | Kind | Tags | Found | Missed | False positives | Cost | Time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const score of report.fixtures) {
    lines.push(
      `| ${inline(score.name)} | ${score.kind} | ${score.tags.map((tag) => inline(tag)).join(", ")} | ${score.matched.length}/${score.expected} | ${score.missed.length} | ${score.falsePositives.length} | ${money(score.costUsd)} | ${seconds(score.durationMs)} |`,
    );
  }
  const details: string[] = [];
  for (const score of report.fixtures) {
    for (const miss of score.missed) {
      details.push(
        `- ${inline(score.name)}: missed ${where(miss.path, miss.lines)}${miss.note === undefined ? "" : `, ${inline(miss.note)}`}`,
      );
    }
    for (const finding of score.falsePositives) {
      details.push(
        `- ${inline(score.name)}: false positive at ${where(finding.path, [finding.start_line ?? finding.line, finding.line])}, ${inline(finding.title)}`,
      );
    }
    for (const error of score.errors) {
      details.push(`- ${inline(score.name)}: ${inline(error)}`);
    }
  }
  if (details.length > 0) lines.push("", "### Details", "", ...details);
  return `${lines.join("\n")}\n`;
}
