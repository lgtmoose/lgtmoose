import { REMOVED_LINES_SHOWN, type DiffLine, type FileDiff, type Hunk } from "@lgtmoose/git";
import { wrapUntrusted } from "./untrusted.js";

/**
 * How closely to review a file. Structurally the same as the planner's batch entries (NIC-806):
 * - full: review every changed line.
 * - move: renamed with identical contents; nothing to review.
 * - mechanical: only import lines changed; check that they still resolve.
 */
export type ReviewDepth = "full" | "move" | "mechanical";

export interface BatchFile {
  file: FileDiff;
  depth: ReviewDepth;
}

export interface ReviewBatch {
  files: BatchFile[];
}

/**
 * The label a diff line is cited by: `R12` is line 12 on the RIGHT side (the new version), `L12`
 * line 12 on the LEFT side (the old version). Context lines exist on both sides; cite them RIGHT.
 */
function label(line: DiffLine): string {
  if (line.kind === "del") return `L${line.oldLine ?? 0}`;
  return `R${line.newLine ?? 0}`;
}

const MARKERS: Record<DiffLine["kind"], string> = { add: "+", del: "-", context: " " };

function renderLines(lines: DiffLine[]): string[] {
  const width = Math.max(0, ...lines.map((line) => label(line).length));
  return lines.map((line) => `${label(line).padEnd(width)} ${MARKERS[line.kind]} ${line.text}`);
}

function renderHunk(hunk: Hunk): string {
  const section = hunk.section === "" ? "" : ` ${hunk.section}`;
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${section}`;
  return [header, ...renderLines(hunk.lines)].join("\n");
}

/** Compresses sorted line numbers into ranges: [3, 4, 5, 9] gives "3-5, 9". */
export function formatRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start: number | undefined;
  let end = 0;
  for (const line of sorted) {
    if (start !== undefined && line === end + 1) {
      end = line;
      continue;
    }
    if (start !== undefined) ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = line;
    end = line;
  }
  if (start !== undefined) ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(", ");
}

/** The diff text of a file, as it goes inside its untrusted block. */
function diffBody({ file, depth }: BatchFile): string {
  if (depth === "move") return "(moved without changes)";
  if (file.submodule) {
    return `(submodule pointer: ${file.oldBlob ?? "none"} -> ${file.newBlob ?? "none"})`;
  }
  if (file.binary) return "(binary file, not shown)";
  if (file.hunks.length === 0) return "(no changed lines in the PR diff)";
  if (depth === "mechanical") {
    // Only the changed lines: the edit is import-only, so context adds little.
    const changed = file.hunks.flatMap((hunk) => hunk.lines.filter((l) => l.kind !== "context"));
    return renderLines(changed).join("\n");
  }
  return file.hunks.map(renderHunk).join("\n");
}

/** Renders one file of the batch: notes we wrote, then its diff as an untrusted block. */
export function renderBatchFile(entry: BatchFile): string {
  const { file, depth } = entry;
  const parts = [
    wrapUntrusted("diff", diffBody(entry), {
      path: file.path,
      old_path: file.oldPath,
      status: file.status,
      depth,
    }),
  ];
  const changed = file.changedSinceLastReview;
  if (changed !== undefined) {
    parts.push(
      changed.length === 0
        ? "Changed since the last review: no added lines."
        : `Changed since the last review: RIGHT ${changed.length === 1 ? "line" : "lines"} ${formatRanges(changed)}.`,
    );
  }
  const deleted = file.deletedSinceLastReview ?? [];
  if (deleted.length > 0) {
    parts.push(
      `Deleted since the last review: LEFT ${deleted.length === 1 ? "line" : "lines"} ${formatRanges(deleted)}.`,
    );
  }
  const removed = file.removedSinceLastReview ?? [];
  if (removed.length > 0) {
    const shown = removed.slice(0, REMOVED_LINES_SHOWN);
    parts.push(
      "Lines the PR added at the last review but no longer adds:",
      wrapUntrusted("removed_since_last_review", shown.join("\n"), { path: file.path }),
    );
    if (removed.length > shown.length) parts.push(`…and ${removed.length - shown.length} more.`);
  }
  return parts.join("\n");
}

/** Renders every file in the batch, in the batch's order. */
export function renderBatch(batch: ReviewBatch): string {
  return batch.files.map(renderBatchFile).join("\n\n");
}
