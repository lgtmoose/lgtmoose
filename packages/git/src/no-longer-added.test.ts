import { describe, expect, it } from "vitest";
import { noLongerAdded, type FileDiff } from "./diff.js";

/** A file at `path` whose PR change adds these lines. */
function adding(path: string, texts: string[], oldPath?: string): FileDiff {
  return {
    path,
    ...(oldPath === undefined ? {} : { oldPath }),
    status: oldPath === undefined ? "modified" : "renamed",
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

const S1 = "1".repeat(40);
const S2 = "2".repeat(40);

describe("noLongerAdded", () => {
  it("adds up names that were separate files when they were reviewed", () => {
    // a.ts and b.ts each had the check, as separate files; now only one file is left without it.
    const before = [
      { change: adding("a.ts", ["requireAdmin(user);"]), reviewedAt: S1 },
      { change: adding("b.ts", ["requireAdmin(user);"]), reviewedAt: S2 },
    ];
    expect(noLongerAdded(before, adding("a.ts", ["other();"]))).toEqual([
      "requireAdmin(user);",
      "requireAdmin(user);",
    ]);
  });

  it("counts a file once when, at the same commit, one name is the other's rename", () => {
    const before = [
      { change: adding("b.ts", ["requireAdmin(user);"], "a.ts"), reviewedAt: S1 },
      { change: adding("a.ts", ["requireAdmin(user);"]), reviewedAt: S1 },
    ];
    expect(noLongerAdded(before, adding("a.ts", ["other();"]))).toEqual(["requireAdmin(user);"]);
  });

  it("keeps real duplicates, lists rewordings, and leaves out lines with nothing to read", () => {
    const then = adding("a.ts", ["assert(ok);", "assert(ok);", "log('old');", "}"]);
    expect(
      noLongerAdded([{ change: then, reviewedAt: S1 }], adding("a.ts", ["log('new');"])),
    ).toEqual(["assert(ok);", "assert(ok);", "log('old');"]);
  });

  it("doesn't take re-indentation or re-spacing for a removal", () => {
    const then = adding("a.ts", ["  if (ok)   return;"]);
    const now = adding("a.ts", ["      if (ok) return;"]);
    expect(noLongerAdded([{ change: then, reviewedAt: S1 }], now)).toEqual([]);
    // The original text is what's reported.
    expect(noLongerAdded([{ change: then, reviewedAt: S1 }], undefined)).toEqual([
      "  if (ok)   return;",
    ]);
  });

  it("lists nothing when the file still adds every line", () => {
    const then = adding("a.ts", ["a();", "b();"]);
    expect(
      noLongerAdded([{ change: then, reviewedAt: S1 }], adding("a.ts", ["b();", "a();", "c();"])),
    ).toEqual([]);
  });
});
