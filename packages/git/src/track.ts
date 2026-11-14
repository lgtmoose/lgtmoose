import type { Repo } from "./clone.js";
import { diffCommits, type FileDiff } from "./diff.js";

/** A line of a file at some commit. */
export interface LineRef {
  path: string;
  line: number;
}

/**
 * Where line `line` of a file's old version is in its new version, from the file's diff
 * between the two. Undefined when the line was deleted or changed (git shows a changed line as
 * deleted and re-added), or the file was deleted or is binary. `file` undefined means the diff
 * doesn't touch the file, so the line is where it was.
 */
export function trackLine(file: FileDiff | undefined, line: number): number | undefined {
  if (file === undefined) return line;
  if (file.status === "deleted" || file.newBlob === undefined) return undefined;
  if (file.hunks.length === 0) return file.binary ? undefined : line;
  let offset = 0;
  for (const hunk of [...file.hunks].sort((a, b) => a.oldStart - b.oldStart)) {
    // A pure insertion's oldStart is the line it comes after.
    const first = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    if (line < first) return line + offset;
    if (line < first + hunk.oldLines) {
      const at = hunk.lines.find((entry) => entry.kind !== "add" && entry.oldLine === line);
      return at?.kind === "context" ? at.newLine : undefined;
    }
    offset += hunk.newLines - hunk.oldLines;
  }
  return line + offset;
}

/**
 * Follows lines from `fromSha` to `toSha` (renames included), with one diff for all of them.
 * Each result is the line at `toSha`, or undefined when it no longer exists there: deleted,
 * changed, or its file deleted.
 */
export async function trackLines(
  repo: Repo,
  fromSha: string,
  toSha: string,
  lines: readonly LineRef[],
): Promise<(LineRef | undefined)[]> {
  if (lines.length === 0) return [];
  const files = new Map<string, FileDiff>();
  if (fromSha !== toSha) {
    const paths = [...new Set(lines.map((ref) => ref.path))];
    for (const file of await diffCommits(repo, fromSha, toSha, { paths })) {
      files.set(file.oldPath ?? file.path, file);
    }
  }
  return lines.map((ref) => {
    const file = files.get(ref.path);
    const line = trackLine(file, ref.line);
    return line === undefined ? undefined : { path: file?.path ?? ref.path, line };
  });
}
