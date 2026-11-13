import type { FileDiff } from "./diff.js";
import type { Hunk } from "./patch.js";

/** RIGHT is the head version of the file; LEFT the base version, for deleted lines. */
export type Side = "LEFT" | "RIGHT";

/** The fields GitHub's "create a review comment" API takes to place a comment. */
export interface CommentPosition {
  path: string;
  side: Side;
  line: number;
  start_line?: number;
  start_side?: Side;
}

export interface CommentTarget {
  position: CommentPosition;
  /**
   * Whether GitHub will accept an inline comment here: every line from `start_line` to `line`
   * is shown in one hunk of the PR diff. When false, put the finding in the review body instead.
   */
  inHunk: boolean;
  /** For RIGHT-side lines, whether the PR added this line (as opposed to context). */
  added: boolean;
}

export interface TargetOptions {
  side?: Side;
  /** First line of a multi-line comment. */
  startLine?: number;
}

function range(hunk: Hunk, side: Side): [number, number] {
  return side === "RIGHT"
    ? [hunk.newStart, hunk.newStart + hunk.newLines - 1]
    : [hunk.oldStart, hunk.oldStart + hunk.oldLines - 1];
}

/** The hunk that shows `line` on `side`, if any. */
export function hunkFor(file: FileDiff, line: number, side: Side = "RIGHT"): Hunk | undefined {
  return file.hunks.find((hunk) => {
    const [first, last] = range(hunk, side);
    return line >= first && line <= last;
  });
}

/**
 * Where a review comment on `line` goes. Comments must sit on lines GitHub shows in the PR diff,
 * so a finding on an unchanged part of the file gets `inHunk: false`.
 */
export function commentTarget(
  file: FileDiff,
  line: number,
  options: TargetOptions = {},
): CommentTarget {
  const side = options.side ?? "RIGHT";
  const start =
    options.startLine !== undefined && options.startLine < line ? options.startLine : undefined;
  const hunk = hunkFor(file, line, side);
  const inHunk = hunk !== undefined && (start === undefined || hunkFor(file, start, side) === hunk);
  const added =
    side === "RIGHT" &&
    hunk !== undefined &&
    hunk.lines.some((l) => l.kind === "add" && l.newLine === line);
  return {
    position: {
      path: file.path,
      side,
      line,
      ...(start === undefined ? {} : { start_line: start, start_side: side }),
    },
    inHunk,
    added,
  };
}
