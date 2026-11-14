import { describe, expect, it } from "vitest";
import { noLongerAdded, type FileDiff } from "./diff.js";

/** A file whose PR change adds these lines. */
function adding(...texts: string[]): FileDiff {
  return {
    path: "a.ts",
    status: "modified",
    oldBlob: "a",
    newBlob: "b",
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: texts.length,
        section: "",
        lines: texts.map((text, i) => ({ kind: "add" as const, newLine: i + 1, text })),
      },
    ],
  };
}

describe("noLongerAdded", () => {
  it("counts the same copy seen under two names once", () => {
    // The file had the check under its old name and its new one: one copy, not two.
    const underOldName = adding("requireAdmin(user);");
    const underNewName = adding("requireAdmin(user);");
    expect(noLongerAdded([underOldName, underNewName], adding("other();"))).toEqual([
      "requireAdmin(user);",
    ]);
  });

  it("keeps real duplicates, and lists rewordings", () => {
    const then = adding("assert(ok);", "assert(ok);", "log('old');", "}");
    expect(noLongerAdded([then], adding("log('new');"))).toEqual([
      "assert(ok);",
      "assert(ok);",
      "log('old');",
    ]);
  });

  it("lists nothing when the file still adds every line", () => {
    expect(noLongerAdded([adding("a();", "b();")], adding("b();", "a();", "c();"))).toEqual([]);
  });
});
