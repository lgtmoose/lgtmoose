import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneAtSha } from "./clone.js";
import { FixtureRepo } from "./testing/fixture.js";
import { trackLine, trackLines } from "./track.js";

let fixture: FixtureRepo;
beforeEach(async () => {
  fixture = await FixtureRepo.create();
});
afterEach(async () => {
  await fixture.destroy();
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

async function track(
  before: Record<string, string>,
  change: () => Promise<void>,
  refs: { path: string; line: number }[],
) {
  await fixture.write(before);
  const from = await fixture.commit("before");
  await change();
  const to = await fixture.commit("after");
  const repo = await cloneAtSha({
    url: fixture.url,
    dir: await fixture.cloneDir(),
    headSha: to,
    otherShas: [from],
  });
  return trackLines(repo, from, to, refs);
}

describe("trackLines", () => {
  it("moves lines past insertions and deletions, and loses changed or deleted lines", async () => {
    const text = lines(30)
      .replace("line 2\n", "line 2\nnew a\nnew b\n")
      .replace("line 10\n", "line 10 changed\n")
      .replace("line 20\n", "");
    const result = await track({ "a.ts": lines(30) }, () => fixture.write({ "a.ts": text }), [
      { path: "a.ts", line: 1 },
      { path: "a.ts", line: 5 },
      { path: "a.ts", line: 10 },
      { path: "a.ts", line: 20 },
      { path: "a.ts", line: 25 },
    ]);
    expect(result).toEqual([
      { path: "a.ts", line: 1 },
      { path: "a.ts", line: 7 },
      undefined,
      undefined,
      { path: "a.ts", line: 26 },
    ]);
  });

  it("follows renames and loses lines of deleted files", async () => {
    const result = await track(
      { "old.ts": lines(10), "gone.ts": lines(5), "same.ts": lines(5) },
      async () => {
        await fixture.move("old.ts", "new.ts");
        await fixture.remove("gone.ts");
      },
      [
        { path: "old.ts", line: 4 },
        { path: "gone.ts", line: 2 },
        { path: "same.ts", line: 3 },
      ],
    );
    expect(result).toEqual([{ path: "new.ts", line: 4 }, undefined, { path: "same.ts", line: 3 }]);
  });
});

describe("trackLine", () => {
  const file = (
    hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[],
  ) => ({
    path: "a.ts",
    status: "modified" as const,
    oldBlob: "a",
    newBlob: "b",
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: hunks.map((hunk) => ({ ...hunk, section: "", lines: [] })),
  });

  it("treats a pure insertion's start as the line it follows", () => {
    // Two lines inserted after line 4.
    const insert = file([{ oldStart: 4, oldLines: 0, newStart: 5, newLines: 2 }]);
    expect(trackLine(insert, 4)).toBe(4);
    expect(trackLine(insert, 5)).toBe(7);
  });

  it("keeps a line when the diff doesn't touch the file", () => {
    expect(trackLine(undefined, 9)).toBe(9);
  });
});
