import type { Finding } from "@lgtmoose/core";
import { commentTarget } from "@lgtmoose/git";
import type { ReviewBatch } from "./diff.js";

/** Where each of a run's findings can go. */
export interface PlacedFindings {
  /** On a line of the batch's diff: can be posted as inline review comments. */
  inline: Finding[];
  /** On a batch file, but outside its hunks. GitHub refuses these inline; put them in the review body. */
  outsideDiff: Finding[];
  /** On a file that isn't in this batch. Not trustworthy; drop them (and log them). */
  otherFile: Finding[];
}

/**
 * Sorts a reviewer run's findings by whether they can be posted where they point. The output
 * schema can't check this: path, line and side are free values, and GitHub rejects the whole
 * review (422) if one inline comment is outside the diff.
 */
export function placeFindings(findings: readonly Finding[], batch: ReviewBatch): PlacedFindings {
  const files = new Map(batch.files.map((entry) => [entry.file.path, entry.file]));
  const placed: PlacedFindings = { inline: [], outsideDiff: [], otherFile: [] };
  for (const finding of findings) {
    const file = files.get(finding.path);
    if (file === undefined) {
      placed.otherFile.push(finding);
      continue;
    }
    const target = commentTarget(file, finding.line, {
      side: finding.side,
      ...(finding.start_line === undefined ? {} : { startLine: finding.start_line }),
    });
    (target.inHunk ? placed.inline : placed.outsideDiff).push(finding);
  }
  return placed;
}
