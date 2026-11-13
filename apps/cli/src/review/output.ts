import type { Finding } from "@lgtmoose/core";
import type { ReviewReport } from "@lgtmoose/pipeline";
import { targetText } from "./target.js";

/**
 * Model output and PR text are untrusted, and a terminal acts on control characters: an escape
 * sequence in a finding could rewrite the screen, set the window title or worse. Everything
 * printed as text goes through this, which drops control characters except newlines and tabs.
 */
export function terminalSafe(text: string): string {
  let out = "";
  for (const char of text) if (!isUnsafe(char.codePointAt(0) ?? 0)) out += char;
  return out;
}

/** C0 controls (but tab and newline), DEL, C1 controls, and bidi controls that reorder text. */
function isUnsafe(code: number): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function where(finding: Finding): string {
  const range =
    finding.start_line === undefined || finding.start_line === finding.line
      ? `${finding.line}`
      : `${finding.start_line}-${finding.line}`;
  return `${finding.path}:${range}${finding.side === "LEFT" ? " (old)" : ""}`;
}

function findingLines(finding: Finding): string[] {
  const lines = [`  [${finding.severity}] ${where(finding)}  ${finding.title}`];
  for (const line of finding.body.split("\n")) lines.push(`      ${line}`);
  if (finding.suggestion !== undefined) {
    lines.push("      Suggestion:");
    for (const line of finding.suggestion.split("\n")) lines.push(`        ${line}`);
  }
  return lines;
}

/** The dry run's result for a person: findings, decision, batches, then the summary comment. */
export function formatText(report: ReviewReport, transcriptDir: string): string {
  const { decision } = report;
  const out = [
    `LGTMoose dry run for ${targetText(report.target)} at ${report.pr.headSha.slice(0, 12)}. Nothing was posted.`,
    `${report.pr.title}`,
    "",
    `Inline findings (${report.inline.length}):`,
    ...(report.inline.length === 0 ? ["  none"] : report.inline.flatMap(findingLines)),
    "",
    `Findings for the review body, outside the diff or on the wrong line (${report.body.length}):`,
    ...(report.body.length === 0 ? ["  none"] : report.body.flatMap(findingLines)),
  ];
  const duplicates = report.dropped.filter((d) => d.reason === "duplicate").length;
  const misplaced = report.dropped.length - duplicates;
  if (report.dropped.length > 0 || report.overLimit > 0) {
    out.push(
      "",
      `Left out: ${duplicates} already raised, ${misplaced} not on a file their batch reviews, ${report.overLimit} over the per-batch limit.`,
    );
  }
  const failed = report.batches.filter((batch) => batch.error !== undefined);
  const reviewed = report.batches.filter((b) => b.error === undefined && b.skipped !== true);
  out.push(
    "",
    `Decision: ${decision.event}, label ${decision.label === undefined ? "unchanged" : `"${decision.label}"`}, check ${decision.conclusion ?? "not posted"}.`,
    `Files: ${report.plan.reviewed} reviewed, ${report.plan.skipped} skipped. Batches: ${reviewed.length} reviewed, ${failed.length} failed of ${report.batches.length}.`,
  );
  for (const batch of failed) out.push(`  Batch ${batch.index + 1} failed: ${batch.error ?? ""}`);
  out.push(
    `Transcripts: ${transcriptDir}`,
    "",
    "Summary comment:",
    "----------------------------------------",
    report.summary.trimEnd(),
    "----------------------------------------",
    "",
  );
  return terminalSafe(out.join("\n"));
}

/** The dry run's result for scripts. Stable keys; JSON escapes any control characters. */
export function formatJson(report: ReviewReport, transcriptDir: string): string {
  return `${JSON.stringify({ ...report, transcriptDir }, null, 2)}\n`;
}
