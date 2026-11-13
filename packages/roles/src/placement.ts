import { keepMostSevere, type Finding } from "@lgtmoose/core";
import { commentTarget, type FileDiff } from "@lgtmoose/git";
import type { ReviewBatch } from "./diff.js";

/** Where each of a run's findings can go. */
export interface PlacedFindings {
  /** On a line of the batch's diff, quoting that line: can be posted as inline comments. */
  inline: Finding[];
  /**
   * On a batch file, but outside its hunks, or quoting text that isn't on the cited lines (so
   * the line number is probably wrong). Put them in the review body, not inline: GitHub refuses
   * an inline comment outside the diff, and a misnumbered one lands on the wrong line.
   */
  outsideDiff: Finding[];
  /**
   * On a file that isn't in this batch, or on a pure rename (depth `move`), which the prompt
   * says not to report on. Not trustworthy; drop them (and log them).
   */
  dropped: Finding[];
  /** Findings past the per-run limit, least severe first to go (see `keepMostSevere`). */
  overLimit: number;
}

/** Whitespace-insensitive form, so indentation the model didn't copy exactly still matches. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A line label and marker as the prompt renders them (`R12 + `), which models often copy. */
const LABEL = /^\s*[RL]\d+\s+[+\- ]\s?/;

/** Whether the evidence is the text of the cited lines. Empty evidence never matches. */
function quotes(cited: string, evidence: string): boolean {
  const quoted = collapse(
    evidence
      .split("\n")
      .map((line) => line.replace(LABEL, ""))
      .join("\n"),
  );
  return quoted !== "" && collapse(cited).includes(quoted);
}

/** The text of the lines a finding cites, on its side, in diff order. */
function citedText(file: FileDiff, finding: Finding): string {
  const first = finding.start_line ?? finding.line;
  const lines = file.hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => {
      const number = finding.side === "RIGHT" ? line.newLine : line.oldLine;
      const onSide = finding.side === "RIGHT" ? line.kind !== "del" : line.kind !== "add";
      return onSide && number !== undefined && number >= first && number <= finding.line;
    }),
  );
  return lines.map((line) => line.text).join("\n");
}

/**
 * Sorts a reviewer run's findings by whether they can be posted where they point. The output
 * schema can't check this: path, line and side are free values, and GitHub rejects the whole
 * review (422) if one inline comment is outside the diff. Only the most severe
 * `FINDING_LIMITS.findingsPerRun` findings are placed.
 */
export function placeFindings(findings: readonly Finding[], batch: ReviewBatch): PlacedFindings {
  const files = new Map(batch.files.map((entry) => [entry.file.path, entry]));
  const { kept, dropped: overLimit } = keepMostSevere(findings);
  const placed: PlacedFindings = { inline: [], outsideDiff: [], dropped: [], overLimit };
  for (const finding of kept) {
    const entry = files.get(finding.path);
    if (entry === undefined || entry.depth === "move") {
      placed.dropped.push(finding);
      continue;
    }
    const target = commentTarget(entry.file, finding.line, {
      side: finding.side,
      ...(finding.start_line === undefined ? {} : { startLine: finding.start_line }),
    });
    const matches = quotes(citedText(entry.file, finding), finding.evidence);
    (target.inHunk && matches ? placed.inline : placed.outsideDiff).push(finding);
  }
  return placed;
}
