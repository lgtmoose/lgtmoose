import { describe, expect, it } from "vitest";
import type { FileDiff } from "./diff.js";
import { parsePatch } from "./patch.js";
import { commentTarget, hunkFor } from "./position.js";

// Two hunks: new lines 3-7 (adds 5) and 20-24 (deletes old 21).
const [patch] = parsePatch(
  [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -3,4 +3,5 @@",
    " a",
    " b",
    "+added",
    " c",
    " d",
    "@@ -19,5 +20,4 @@",
    " e",
    "-removed",
    " f",
    " g",
    " h",
    "",
  ].join("\n"),
);
const file: FileDiff = {
  path: "f.ts",
  status: "modified",
  oldBlob: "a",
  newBlob: "b",
  moved: false,
  mechanical: false,
  binary: false,
  hunks: patch?.hunks ?? [],
};

describe("commentTarget", () => {
  it("places a comment on an added line", () => {
    expect(commentTarget(file, 5)).toEqual({
      position: { path: "f.ts", side: "RIGHT", line: 5 },
      inHunk: true,
      added: true,
    });
  });

  it("accepts context lines but says they weren't added", () => {
    expect(commentTarget(file, 3)).toMatchObject({ inHunk: true, added: false });
  });

  it("puts deleted lines on the LEFT side", () => {
    expect(commentTarget(file, 20, { side: "LEFT" })).toMatchObject({
      position: { side: "LEFT", line: 20 },
      inHunk: true,
      added: false,
    });
  });

  it("reports lines GitHub doesn't show as outside any hunk", () => {
    expect(commentTarget(file, 12).inHunk).toBe(false);
    expect(hunkFor(file, 12)).toBeUndefined();
  });

  it("spans lines only within one hunk", () => {
    expect(commentTarget(file, 7, { startLine: 3 })).toEqual({
      position: { path: "f.ts", side: "RIGHT", line: 7, start_line: 3, start_side: "RIGHT" },
      inHunk: true,
      added: false,
    });
    expect(commentTarget(file, 21, { startLine: 5 }).inHunk).toBe(false);
  });

  it("ignores a start line that isn't before the line", () => {
    expect(commentTarget(file, 5, { startLine: 5 }).position).not.toHaveProperty("start_line");
  });
});
