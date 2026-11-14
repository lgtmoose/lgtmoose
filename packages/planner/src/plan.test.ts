import type { FileDiff, Hunk } from "@lgtmoose/git";
import { describe, expect, it } from "vitest";
import { BINARY_LOCKFILE_NOTE } from "./lockfile.js";
import {
  OTHER_TIER,
  TEST_TIER,
  changedLines,
  checkpointAfter,
  planReview,
  readingDepth,
  remainingBatches,
  tierClassifier,
  type PlannedFile,
} from "./plan.js";

/** A hunk with `adds` added and `dels` deleted lines, plus one line of context. */
function hunk(adds: number, dels = 0): Hunk {
  return {
    oldStart: 1,
    oldLines: dels + 1,
    newStart: 1,
    newLines: adds + 1,
    section: "",
    lines: [
      { kind: "context", oldLine: 1, newLine: 1, text: "ctx" },
      ...Array.from({ length: dels }, (_, i) => ({
        kind: "del" as const,
        oldLine: i + 2,
        text: `old ${i}`,
      })),
      ...Array.from({ length: adds }, (_, i) => ({
        kind: "add" as const,
        newLine: i + 2,
        text: `new ${i}`,
      })),
    ],
  };
}

function diff(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    status: "modified",
    oldBlob: "a".repeat(40),
    newBlob: "b".repeat(40),
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: [hunk(1)],
    ...overrides,
  };
}

const noConfig = { skip: [], tiers: {} };
const paths = (files: PlannedFile[]) => files.map((f) => f.file.path);

describe("readingDepth", () => {
  it("reads moves and mechanical edits lightly, everything else in full", () => {
    expect(readingDepth(diff("a.ts", { moved: true, status: "renamed" }))).toBe("move");
    expect(readingDepth(diff("a.ts", { mechanical: true }))).toBe("mechanical");
    expect(readingDepth(diff("a.ts"))).toBe("full");
  });

  it("reads a file with lines it stopped adding in full, moved or not", () => {
    const dropped = { removedSinceLastReview: ["requireAdmin(user);"] };
    expect(readingDepth(diff("a.ts", { moved: true, status: "renamed", ...dropped }))).toBe("full");
    expect(readingDepth(diff("a.ts", { mechanical: true, ...dropped }))).toBe("full");
  });
});

describe("changedLines", () => {
  it("counts added and deleted lines, not context", () => {
    expect(changedLines(diff("a.ts", { hunks: [hunk(3, 2), hunk(1)] }))).toBe(6);
    expect(changedLines(diff("a.ts", { hunks: [] }))).toBe(0);
  });

  it("counts the whole PR diff on an incremental review, since the prompt shows it", () => {
    const file = diff("a.ts", {
      hunks: [hunk(300)],
      changedSinceLastReview: [12],
      removedSinceLastReview: [],
    });
    expect(changedLines(file)).toBe(300);
  });

  it("counts removed lines for a file the PR no longer changes", () => {
    const reverted = diff("a.ts", { hunks: [], removedSinceLastReview: ["a", "b"] });
    expect(changedLines(reverted)).toBe(2);
  });
});

describe("tierClassifier", () => {
  const tierOf = tierClassifier({
    "3": ["src/**"],
    "1": ["src/auth/**", "**/*.sql"],
    "7": ["docs/**"],
  });

  it("takes the most important tier a file matches", () => {
    expect(tierOf("src/auth/login.ts")).toBe(1);
    expect(tierOf("src/app.ts")).toBe(3);
    expect(tierOf("db/0001.sql")).toBe(1);
    expect(tierOf("docs/guide.md")).toBe(7);
  });

  it("puts unmatched files in everything else", () => {
    expect(tierOf("scripts/run.sh")).toBe(OTHER_TIER);
  });

  it("puts tests last, even when a tier glob matches them", () => {
    expect(tierOf("src/auth/login.test.ts")).toBe(TEST_TIER);
    expect(tierOf("tests/e2e.py")).toBe(TEST_TIER);
  });

  it("works with no tiers", () => {
    expect(tierClassifier({})("src/app.ts")).toBe(OTHER_TIER);
  });
});

describe("planReview", () => {
  it("skips files with a reason and keeps the rest", () => {
    const plan = planReview(
      [
        diff("src/app.ts"),
        diff("pnpm-lock.yaml"),
        diff("logo.png", { binary: true, hunks: [] }),
        diff("docs/guide.md"),
      ],
      { skip: ["docs/**"], tiers: {} },
    );
    expect(paths(plan.files)).toEqual(["src/app.ts"]);
    expect(plan.skipped.map((s) => [s.file.path, s.reason, s.glob])).toEqual([
      ["docs/guide.md", "config", "docs/**"],
      ["logo.png", "binary", undefined],
      ["pnpm-lock.yaml", "lockfile", "**/pnpm-lock.yaml"],
    ]);
  });

  it("sorts by tier, then path, whatever the input order", () => {
    const config = { skip: [], tiers: { "1": ["src/auth/**"], "2": ["src/api/**"] } };
    const input = [
      diff("src/z.test.ts"),
      diff("README.md"),
      diff("src/api/users.ts"),
      diff("src/auth/token.ts"),
      diff("src/a.test.ts"),
      diff("Makefile"),
      diff("src/api/orders.ts"),
      diff("src/auth/login.ts"),
    ];
    const plan = planReview(input, config);
    expect(paths(plan.files)).toEqual([
      "src/auth/login.ts",
      "src/auth/token.ts",
      "src/api/orders.ts",
      "src/api/users.ts",
      "Makefile",
      "README.md",
      "src/a.test.ts",
      "src/z.test.ts",
    ]);
    expect(plan.files.map((f) => f.tier)).toEqual([1, 1, 2, 2, 8, 8, 9, 9]);
    expect(plan.files.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(planReview([...input].reverse(), config)).toEqual(plan);
  });

  it("reviews a few files the PR adds to vendor/ or build/, but skips bulk vendoring", () => {
    const added = (path: string) => diff(path, { status: "added", oldBlob: undefined });
    const few = planReview([added("vendor/analytics.js"), diff("vendor/old.js")], noConfig);
    expect(paths(few.files)).toEqual(["vendor/analytics.js"]);
    expect(few.skipped.map((s) => s.file.path)).toEqual(["vendor/old.js"]);

    const bulk = Array.from({ length: 5 }, (_, i) => added(`vendor/lib/f${i}.js`));
    const plan = planReview(bulk, noConfig);
    expect(plan.files).toEqual([]);
    expect(plan.skipped.every((s) => s.newCode === true)).toBe(true);
  });

  it("reviews a few added files with generated or minified names, but not snapshots", () => {
    const added = (path: string) => diff(path, { status: "added", oldBlob: undefined });
    const plan = planReview(
      [
        added("src/auth/session.generated.ts"),
        added("public/app.min.js"),
        added("src/__snapshots__/view.test.ts.snap"),
      ],
      noConfig,
    );
    expect(paths(plan.files)).toEqual(["public/app.min.js", "src/auth/session.generated.ts"]);
    expect(plan.skipped.map((s) => s.file.path)).toEqual(["src/__snapshots__/view.test.ts.snap"]);
  });

  it("plans included files like any other, through tiers and batches", () => {
    const files = [diff("packages/web/dist/index.js"), diff("src/build/run.ts")];
    expect(paths(planReview(files, noConfig).files)).toEqual(["src/build/run.ts"]);
    const plan = planReview(files, {
      ...noConfig,
      tiers: { "1": ["packages/web/**"] },
      include: ["packages/*/dist/**"],
    });
    expect(plan.files.map((f) => [f.file.path, f.tier])).toEqual([
      ["packages/web/dist/index.js", 1],
      ["src/build/run.ts", 8],
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("reviews an included lockfile as text, without lockfile notes", () => {
    const lock = diff("package-lock.json");
    const plan = planReview([lock], { ...noConfig, include: ["package-lock.json"] });
    expect(paths(plan.files)).toEqual(["package-lock.json"]);
    expect(plan.skipped).toEqual([]);
  });

  it("attaches lockfile notes to a skipped lockfile", () => {
    const lock = diff("package-lock.json", {
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          section: "",
          lines: [
            { kind: "add", newLine: 1, text: '"resolved": "https://evil.example.com/x.tgz"' },
          ],
        },
      ],
    });
    expect(planReview([lock], noConfig).skipped[0]?.notes).toEqual([
      "1 package resolves from evil.example.com, not a known registry (first at line 1)",
    ]);
    expect(
      planReview([lock], { ...noConfig, registries: ["evil.example.com"] }).skipped[0]?.notes,
    ).toBe(undefined);
  });

  it("notes a changed binary lockfile, which can't be scanned", () => {
    const lockb = diff("bun.lockb", { binary: true, hunks: [] });
    expect(planReview([lockb], noConfig).skipped[0]).toMatchObject({
      reason: "binary",
      notes: [BINARY_LOCKFILE_NOTE],
    });
  });

  it("can't be padded past the bulk limit with maps, licences or other folders", () => {
    const added = (path: string) => diff(path, { status: "added", oldBlob: undefined });
    const padded = [
      added("vendor/analytics.js"),
      added("vendor/LICENSE"),
      added("vendor/NOTICE.md"),
      added("vendor/analytics.js.map"),
      added("vendor/a.min.css.map"),
      added("third_party/x.c"),
      added("third_party/y.c"),
      added("packages/web/dist/a.js"),
      added("packages/web/dist/b.js"),
    ];
    const plan = planReview(padded, noConfig);
    expect(paths(plan.files)).toContain("vendor/analytics.js");
    expect(paths(plan.files)).toContain("third_party/x.c");
    expect(paths(plan.files)).toContain("packages/web/dist/a.js");
  });

  it("orders paths by code unit, not locale", () => {
    const plan = planReview([diff("b.ts"), diff("B.ts"), diff("a.ts"), diff("_.ts")], noConfig);
    expect(paths(plan.files)).toEqual(["B.ts", "_.ts", "a.ts", "b.ts"]);
  });

  it("sets depth and changed lines per file", () => {
    const plan = planReview(
      [
        diff("a.ts", { hunks: [hunk(4, 2)] }),
        diff("b.ts", { moved: true, status: "renamed", oldPath: "old/b.ts", hunks: [] }),
        diff("c.ts", { mechanical: true, hunks: [hunk(1, 1)] }),
      ],
      noConfig,
    );
    expect(plan.files.map((f) => [f.file.path, f.depth, f.changedLines])).toEqual([
      ["a.ts", "full", 6],
      ["b.ts", "move", 0],
      ["c.ts", "mechanical", 2],
    ]);
  });

  it("plans submodule bumps as full-depth files", () => {
    const bump = diff("libs/shared", { submodule: true, hunks: [hunk(1, 1)] });
    const plan = planReview([bump], noConfig);
    expect(plan.skipped).toEqual([]);
    expect(plan.files.map((f) => [f.file.path, f.depth, f.tier])).toEqual([
      ["libs/shared", "full", OTHER_TIER],
    ]);
  });

  it("keeps deleted files, which can remove something that mattered", () => {
    const plan = planReview(
      [diff("src/guard.ts", { status: "deleted", newBlob: undefined })],
      noConfig,
    );
    expect(paths(plan.files)).toEqual(["src/guard.ts"]);
  });

  it("gives an empty plan for an empty diff", () => {
    const plan = planReview([], noConfig);
    expect(plan.files).toEqual([]);
    expect(plan.batches).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("rejects limits that aren't positive integers", () => {
    expect(() => planReview([], noConfig, { maxFiles: 0 })).toThrow(RangeError);
    expect(() => planReview([], noConfig, { maxLines: 1.5 })).toThrow(RangeError);
  });
});

describe("batches", () => {
  const files = (count: number, lines = 1) =>
    Array.from({ length: count }, (_, i) =>
      diff(`src/f${String(i).padStart(2, "0")}.ts`, { hunks: [hunk(lines)] }),
    );
  const sizes = (plan: ReturnType<typeof planReview>) => plan.batches.map((b) => b.files.length);

  it("holds at most 10 files by default", () => {
    const plan = planReview(files(25), noConfig);
    expect(sizes(plan)).toEqual([10, 10, 5]);
    expect(plan.batches.map((b) => b.index)).toEqual([0, 1, 2]);
    expect(plan.batches.flatMap((b) => b.files)).toEqual(plan.files);
  });

  it("holds at most 1,500 changed lines by default", () => {
    const plan = planReview(files(5, 400), noConfig);
    expect(sizes(plan)).toEqual([3, 2]);
    expect(plan.batches.map((b) => b.changedLines)).toEqual([1200, 800]);
  });

  it("fills a batch up to exactly the line limit", () => {
    const plan = planReview(files(4, 500), noConfig);
    expect(plan.batches.map((b) => b.changedLines)).toEqual([1500, 500]);
  });

  it("gives a very large file a batch of its own", () => {
    const input = [
      diff("a.ts"),
      diff("b.ts", { hunks: [hunk(1000, 600)] }),
      diff("c.ts"),
      diff("d.ts"),
    ];
    const plan = planReview(input, noConfig);
    expect(plan.batches.map((b) => paths(b.files))).toEqual([["a.ts"], ["b.ts"], ["c.ts", "d.ts"]]);
    expect(plan.batches[1]?.changedLines).toBe(1600);
  });

  it("takes custom limits", () => {
    const plan = planReview(files(7, 10), noConfig, { maxFiles: 3, maxLines: 25 });
    expect(sizes(plan)).toEqual([2, 2, 2, 1]);
  });

  it("counts moves as no lines, so they pack in", () => {
    const moves = Array.from({ length: 4 }, (_, i) =>
      diff(`m${i}.ts`, { moved: true, status: "renamed", hunks: [] }),
    );
    const plan = planReview([...moves, ...files(1, 1500)], noConfig);
    expect(sizes(plan)).toEqual([4, 1]);
  });
});

describe("resuming", () => {
  const input = Array.from({ length: 30 }, (_, i) => diff(`src/f${String(i).padStart(2, "0")}.ts`));

  it("gives the same fingerprint for the same input in any order", () => {
    const a = planReview(input, noConfig);
    const b = planReview([...input].reverse(), noConfig);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("changes the fingerprint when the files, config or limits change", () => {
    const base = planReview(input, noConfig).fingerprint;
    const edited = input.map((f, i) => (i === 3 ? { ...f, newBlob: "c".repeat(40) } : f));
    expect(planReview(edited, noConfig).fingerprint).not.toBe(base);
    expect(planReview(input, { skip: [], tiers: { "1": ["src/f29.ts"] } }).fingerprint).not.toBe(
      base,
    );
    expect(planReview(input, noConfig, { maxFiles: 5 }).fingerprint).not.toBe(base);
  });

  it("picks up after the last reviewed batch", () => {
    const plan = planReview(input, noConfig);
    const checkpoint = checkpointAfter(plan, 0);
    expect(checkpoint).toEqual({ fingerprint: plan.fingerprint, nextBatch: 1 });
    const later = planReview([...input].reverse(), noConfig);
    expect(remainingBatches(later, checkpoint).map((b) => b.index)).toEqual([1, 2]);
    expect(remainingBatches(later, checkpointAfter(later, 2))).toEqual([]);
  });

  it("starts over without a checkpoint, or with one from another plan", () => {
    const plan = planReview(input, noConfig);
    expect(remainingBatches(plan)).toEqual(plan.batches);
    expect(remainingBatches(plan, { fingerprint: "other", nextBatch: 2 })).toEqual(plan.batches);
  });
});
