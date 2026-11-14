import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneAtSha, type Repo } from "./clone.js";
import { reviewDiff, type FileDiff } from "./diff.js";
import { FixtureRepo } from "./testing/fixture.js";

let fixture: FixtureRepo;
beforeEach(async () => {
  fixture = await FixtureRepo.create();
});
afterEach(async () => {
  await fixture.destroy();
});

async function clone(head: string, others: string[] = []): Promise<Repo> {
  return cloneAtSha({
    url: fixture.url,
    dir: await fixture.cloneDir(),
    headSha: head,
    otherShas: others,
  });
}

function byPath(files: FileDiff[]): Record<string, FileDiff> {
  return Object.fromEntries(files.map((f) => [f.path, f]));
}

/** Every file the PR changed at `sha`, as reviewed there (what one posted run records). */
async function reviewedAllAt(sha: string): Promise<Map<string, string>> {
  const mergeBase = await fixture.git(["merge-base", "main", sha]);
  const names = await fixture.git(["diff", "--name-only", "--find-renames", mergeBase, sha]);
  return new Map(
    names
      .split("\n")
      .filter((name) => name !== "")
      .map((name) => [name, sha]),
  );
}

const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

/** main with some files, then a `pr` branch. Returns the base commit. */
async function setUp(files: Record<string, string | Buffer>): Promise<string> {
  await fixture.write(files);
  const base = await fixture.commit("base");
  await fixture.checkout("pr", true);
  return base;
}

describe("reviewDiff: first review", () => {
  it("reports changed lines with numbers on both sides", async () => {
    const base = await setUp({ "src/a.ts": lines(20) });
    await fixture.write({
      "src/a.ts": lines(20).replace("line 10\n", "line 10 changed\nline 10b\n"),
    });
    const head = await fixture.commit("change a");

    const diff = await reviewDiff(await clone(head, [base]), { baseSha: base });
    expect(diff.kind).toBe("full");
    const [file] = diff.files;
    expect(file).toMatchObject({
      path: "src/a.ts",
      status: "modified",
      moved: false,
      mechanical: false,
    });
    const changed = file?.hunks[0]?.lines.filter((l) => l.kind !== "context");
    expect(changed).toEqual([
      { kind: "del", oldLine: 10, text: "line 10" },
      { kind: "add", newLine: 10, text: "line 10 changed" },
      { kind: "add", newLine: 11, text: "line 10b" },
    ]);
  });

  it("covers base...head, leaving out what the base branch did meanwhile", async () => {
    const base = await setUp({ "a.txt": lines(5), "b.txt": lines(5) });
    await fixture.write({ "a.txt": lines(5).replace("line 1\n", "pr\n") });
    const head = await fixture.commit("pr change");
    await fixture.checkout("main");
    await fixture.write({ "b.txt": "main moved on\n" });
    const mainHead = await fixture.commit("main change");

    const diff = await reviewDiff(await clone(head, [mainHead]), { baseSha: mainHead });
    expect(diff.mergeBase).toBe(base);
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("tells moves (same blob) from renames with edits", async () => {
    const base = await setUp({ "old/moved.ts": lines(10), "old/edited.ts": lines(10, "x") });
    await fixture.move("old/moved.ts", "new/moved.ts");
    await fixture.move("old/edited.ts", "new/edited.ts");
    await fixture.write({ "new/edited.ts": lines(10, "x").replace("x 5\n", "x five\n") });
    const head = await fixture.commit("move");

    const files = byPath((await reviewDiff(await clone(head, [base]), { baseSha: base })).files);
    expect(files["new/moved.ts"]).toMatchObject({
      status: "renamed",
      oldPath: "old/moved.ts",
      moved: true,
      hunks: [],
    });
    expect(files["new/edited.ts"]).toMatchObject({
      status: "renamed",
      oldPath: "old/edited.ts",
      moved: false,
    });
    expect(files["new/edited.ts"]?.hunks).toHaveLength(1);
  });

  it("flags import-only edits as mechanical, including multi-line imports", async () => {
    const before = `import { a } from "./a.js";\nimport {\n  b,\n  c,\n} from "./bc.js";\n\nexport const x = a + b + c;\n`;
    const base = await setUp({
      "src/x.ts": before,
      "src/y.ts": before,
      "src/z.py": "import os\n\nprint(os.name)\n",
    });
    await fixture.write({
      // Only imports change.
      "src/x.ts": before.replace('"./a.js"', '"../lib/a.js"').replace("  c,\n", "  c,\n  d,\n"),
      // An import and real code change.
      "src/y.ts": before.replace('"./a.js"', '"../lib/a.js"').replace("a + b + c", "a * b * c"),
      "src/z.py": "import os\nfrom sys import (\n    argv,\n)\n\nprint(os.name)\n",
    });
    const head = await fixture.commit("imports");

    const files = byPath((await reviewDiff(await clone(head, [base]), { baseSha: base })).files);
    expect(files["src/x.ts"]?.mechanical).toBe(true);
    expect(files["src/y.ts"]?.mechanical).toBe(false);
    expect(files["src/z.py"]?.mechanical).toBe(true);
  });

  it("handles added, deleted and binary files and unusual paths", async () => {
    const base = await setUp({
      "gone.txt": "bye\n",
      "logo.png": Buffer.from([0, 1, 2, 3, 0, 255]),
    });
    await fixture.remove("gone.txt");
    await fixture.write({
      "logo.png": Buffer.from([0, 1, 2, 3, 0, 254]),
      "docs/read me ü.md": "hello\n",
      'odd "quoted".txt': "q\n",
    });
    const head = await fixture.commit("misc");

    const files = byPath((await reviewDiff(await clone(head, [base]), { baseSha: base })).files);
    expect(files["gone.txt"]).toMatchObject({ status: "deleted", newBlob: undefined });
    expect(files["gone.txt"]?.oldBlob).toMatch(/^[0-9a-f]{40}$/);
    expect(files["gone.txt"]?.hunks[0]?.lines).toEqual([{ kind: "del", oldLine: 1, text: "bye" }]);
    expect(files["logo.png"]).toMatchObject({
      status: "modified",
      binary: true,
      hunks: [],
      mechanical: false,
    });
    expect(files["docs/read me ü.md"]).toMatchObject({ status: "added", oldBlob: undefined });
    expect(files["docs/read me ü.md"]?.hunks[0]?.lines).toEqual([
      { kind: "add", newLine: 1, text: "hello" },
    ]);
    expect(files['odd "quoted".txt']?.status).toBe("added");
  });
});

describe("reviewDiff: edge cases", () => {
  it("handles a submodule bump without reading it as a file", async () => {
    await setUp({ "a.txt": "a\n" });
    const base = await fixture.commitGitlink("vendor/lib", "1".repeat(40), "add submodule");
    const head = await fixture.commitGitlink("vendor/lib", "2".repeat(40), "bump submodule");

    const [file] = (await reviewDiff(await clone(head, [base]), { baseSha: base })).files;
    expect(file).toMatchObject({
      path: "vendor/lib",
      status: "modified",
      submodule: true,
      mechanical: false,
    });
    expect(file?.hunks[0]?.lines.map((l) => l.text)).toEqual([
      `Subproject commit ${"1".repeat(40)}`,
      `Subproject commit ${"2".repeat(40)}`,
    ]);
  });

  it("keeps both halves of a file turned into a symlink", async () => {
    const base = await setUp({ "config.json": "{}\n", "real.json": "{}\n" });
    await fixture.remove("config.json");
    await fixture.symlink("real.json", "config.json");
    const head = await fixture.commit("symlink");

    const [file] = (await reviewDiff(await clone(head, [base]), { baseSha: base })).files;
    expect(file?.status).toBe("type-changed");
    expect(file?.hunks.flatMap((h) => h.lines)).toEqual([
      { kind: "del", oldLine: 1, text: "{}" },
      { kind: "add", newLine: 1, text: "real.json" },
    ]);
  });

  it("only calls an edit mechanical when an import changed", async () => {
    const base = await setUp({
      "a.ts": "import x from 'x';\n\nexport const a = x;\n",
      "notes.md": "import this\n",
    });
    await fixture.write({
      "a.ts": "import x from 'x';\n\n\nexport const a = x;\n",
      "notes.md": "import that\n",
    });
    const head = await fixture.commit("blank line and prose");

    const files = byPath((await reviewDiff(await clone(head, [base]), { baseSha: base })).files);
    expect(files["a.ts"]?.mechanical).toBe(false);
    expect(files["notes.md"]?.mechanical).toBe(false);
  });

  it("diffs a large PR with every blob read in one batch", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [`src/f${i}.ts`, `import a from "a${i}";\n`]),
    );
    const base = await setUp(many);
    await fixture.write(
      Object.fromEntries(Object.keys(many).map((p, i) => [p, `import a from "b${i}";\n`])),
    );
    const head = await fixture.commit("rename imports everywhere");

    const diff = await reviewDiff(await clone(head, [base]), { baseSha: base });
    expect(diff.files).toHaveLength(150);
    expect(diff.files.every((f) => f.mechanical)).toBe(true);
  });
});

describe("reviewDiff: incremental review", () => {
  it("keeps only lines the PR changed since the last review", async () => {
    const base = await setUp({ "a.txt": lines(30), "b.txt": lines(30) });
    await fixture.write({
      "a.txt": lines(30).replace("line 3\n", "first pass\n"),
      "b.txt": lines(30).replace("line 3\n", "b pass\n"),
    });
    const reviewed = await fixture.commit("first pass");
    await fixture.write({
      "a.txt": lines(30).replace("line 3\n", "first pass\n").replace("line 25\n", "second pass\n"),
    });
    const head = await fixture.commit("second pass");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: await reviewedAllAt(reviewed),
    });
    expect(diff.kind).toBe("incremental");
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(diff.files[0]?.changedSinceLastReview).toEqual([25]);
    // The hunks are still the whole PR diff, so comments can go anywhere GitHub shows.
    expect(diff.files[0]?.hunks).toHaveLength(2);
  });

  it("leaves out changes that came in by merging the base branch", async () => {
    await setUp({ "shared.txt": lines(40), "main-only.txt": lines(5) });
    await fixture.write({ "shared.txt": lines(40).replace("line 2\n", "pr edit\n") });
    const reviewed = await fixture.commit("pr edit");

    await fixture.checkout("main");
    await fixture.write({
      "shared.txt": lines(40).replace("line 38\n", "main edit\n"),
      "main-only.txt": "main\n",
    });
    const mainHead = await fixture.commit("main moves on");
    await fixture.checkout("pr");
    await fixture.merge("main");
    await fixture.write({
      "shared.txt": lines(40)
        .replace("line 2\n", "pr edit\n")
        .replace("line 38\n", "main edit\n")
        .replace("line 20\n", "pr second\n"),
    });
    const head = await fixture.commit("pr second");

    const diff = await reviewDiff(await clone(head, [mainHead, reviewed]), {
      baseSha: mainHead,
      reviewedAt: await reviewedAllAt(reviewed),
    });
    expect(diff.files.map((f) => f.path)).toEqual(["shared.txt"]);
    expect(diff.files[0]?.changedSinceLastReview).toEqual([20]);
    // main's line 38 isn't in the PR diff at all.
    const added = diff.files[0]?.hunks.flatMap((h) =>
      h.lines.filter((l) => l.kind === "add").map((l) => l.text),
    );
    expect(added).toEqual(["pr edit", "pr second"]);
  });

  it("after a rebase, still shows only the PR's new work", async () => {
    await setUp({ "a.txt": lines(30), "b.txt": lines(30) });
    await fixture.write({ "a.txt": lines(30).replace("line 1\n", "pr one\n") });
    const reviewed = await fixture.commit("pr one");
    await fixture.checkout("main");
    await fixture.write({ "b.txt": lines(30).replace("line 30\n", "main change\n") });
    const mainHead = await fixture.commit("main change");
    await fixture.checkout("pr");
    await fixture.rebase("main");
    await fixture.write({
      "a.txt": lines(30).replace("line 1\n", "pr one\n").replace("line 15\n", "pr two\n"),
    });
    const head = await fixture.commit("pr two");

    // The pre-rebase commit is still fetchable, so this stays incremental.
    const diff = await reviewDiff(await clone(head, [mainHead, reviewed]), {
      baseSha: mainHead,
      reviewedAt: await reviewedAllAt(reviewed),
    });
    expect(diff.kind).toBe("incremental");
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(diff.files[0]?.changedSinceLastReview).toEqual([15]);
  });

  it("falls back to a full review when a force-push removed the last reviewed commit", async () => {
    const base = await setUp({ "a.txt": lines(10) });
    await fixture.write({ "a.txt": lines(10).replace("line 2\n", "draft\n") });
    const reviewed = await fixture.commit("draft");
    await fixture.git(["reset", "--quiet", "--hard", base]);
    await fixture.write({ "a.txt": lines(10).replace("line 2\n", "rewritten\n") });
    const head = await fixture.commit("rewritten");
    await fixture.collectGarbage();

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: await reviewedAllAt(reviewed),
    });
    expect(diff.kind).toBe("full");
    expect(diff.fallbackReason).toContain("force-pushed away");
    expect(diff.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("reports lines the PR stopped adding since the last review", async () => {
    const base = await setUp({ "auth.ts": lines(20), "other.ts": lines(5) });
    await fixture.write({
      "auth.ts": lines(20).replace("line 10\n", "line 10\nrequireAdmin(user);\n"),
      "other.ts": lines(5).replace("line 1\n", "temporary\n"),
    });
    const reviewed = await fixture.commit("add the check");
    await fixture.write({
      "auth.ts": lines(20).replace("line 1\n", "line one\n"),
      "other.ts": lines(5),
    });
    const head = await fixture.commit("drop the check, revert other.ts");

    const files = byPath(
      (
        await reviewDiff(await clone(head, [base, reviewed]), {
          baseSha: base,
          reviewedAt: await reviewedAllAt(reviewed),
        })
      ).files,
    );
    expect(files["auth.ts"]?.removedSinceLastReview).toEqual(["requireAdmin(user);"]);
    // Fully reverted: nothing left to review in it, but what it took out is reported.
    expect(files["other.ts"]).toBeUndefined();
    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: await reviewedAllAt(reviewed),
    });
    expect(diff.noLongerChanged).toEqual([{ path: "other.ts", lines: ["temporary"] }]);
    expect(diff.unchanged).toContain("other.ts");
  });

  it("has nothing to review in a file the PR added and dropped again", async () => {
    const base = await setUp({ "keep.txt": "k\n" });
    await fixture.write({ "added.ts": "export const debug = true;\n" });
    const reviewed = await fixture.commit("add a file");
    await fixture.remove("added.ts");
    const head = await fixture.commit("drop it again");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["added.ts", reviewed]]),
    });
    expect(diff.files).toEqual([]);
    // Covered at this head: nothing left of the PR's change to it.
    expect(diff.unchanged).toEqual(["added.ts"]);
    expect(diff.noLongerChanged).toEqual([]);
  });

  it("reports what an undone rename no longer adds, with nothing to review", async () => {
    const base = await setUp({ "old.ts": lines(10) });
    await fixture.move("old.ts", "new.ts");
    await fixture.write({ "new.ts": lines(10).replace("line 3\n", "line 3\ncheck();\n") });
    const reviewed = await fixture.commit("rename and add a check");
    await fixture.move("new.ts", "old.ts");
    await fixture.write({ "old.ts": lines(10) });
    const head = await fixture.commit("undo it all");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: await reviewedAllAt(reviewed),
    });
    // The file is back as the base has it: nothing to review, no stub entry, but what the
    // reviewed rename added and the PR no longer does is reported under the reviewed name.
    expect(diff.files).toEqual([]);
    expect(diff.noLongerChanged).toEqual([{ path: "new.ts", lines: ["check();"] }]);
  });

  it("compares each file with its own last review, so a base merge doesn't bring one back", async () => {
    await setUp({ "a.ts": lines(30), "b.ts": lines(10) });
    // The PR changes both; a.ts was reviewed at `first`, then b.ts again at `second`.
    await fixture.write({
      "a.ts": lines(30).replace("line 5\n", "line 5 pr\n"),
      "b.ts": lines(10).replace("line 2\n", "line 2 pr\n"),
    });
    const first = await fixture.commit("pr change");
    await fixture.write({ "b.ts": lines(10).replace("line 2\n", "line 2 pr again\n") });
    const second = await fixture.commit("b again");
    // main changes a.ts far from the PR's line, and the PR merges main.
    await fixture.checkout("main");
    await fixture.write({ "a.ts": lines(30).replace("line 25\n", "line 25 main\n") });
    const main = await fixture.commit("main edits a.ts");
    await fixture.checkout("pr");
    await fixture.git(["merge", "--quiet", "--no-edit", main]);
    await fixture.git(["push", "--quiet", "--force", "--all", "origin"]);
    const head = await fixture.git(["rev-parse", "HEAD"]);

    const diff = await reviewDiff(await clone(head, [main, first, second]), {
      baseSha: main,
      reviewedAt: new Map([
        ["a.ts", first],
        ["b.ts", second],
      ]),
    });
    // a.ts's blob changed (the merge), but not its PR change: covered, not reviewed again.
    expect(diff.kind).toBe("incremental");
    expect(diff.files).toEqual([]);
    expect(diff.unchanged.toSorted()).toEqual(["a.ts", "b.ts"]);
  });

  it("keeps lines a file stopped adding since its own, older review", async () => {
    const base = await setUp({ "auth.ts": lines(20), "other.ts": lines(5) });
    await fixture.write({
      "auth.ts": lines(20).replace("line 10\n", "line 10\nrequireAdmin(user);\n"),
    });
    // Reviewed here, but auth.ts's batch failed at the next head, so its record stays here.
    const reviewed = await fixture.commit("add the check");
    await fixture.write({
      "auth.ts": lines(20),
      "other.ts": lines(5).replace("line 1\n", "first\n"),
    });
    const failed = await fixture.commit("drop the check");
    await fixture.write({ "other.ts": lines(5).replace("line 1\n", "one\n") });
    const head = await fixture.commit("later");

    const diff = await reviewDiff(await clone(head, [base, reviewed, failed]), {
      baseSha: base,
      reviewedAt: new Map([
        ["auth.ts", reviewed],
        ["other.ts", failed],
      ]),
    });
    // auth.ts is back as the base has it: its dropped check is reported, not reviewed.
    expect(diff.noLongerChanged).toEqual([{ path: "auth.ts", lines: ["requireAdmin(user);"] }]);
    expect(byPath(diff.files)["other.ts"]?.changedSinceLastReview).toEqual([1]);
  });

  it("reviews a file never reviewed, and one whose last review is gone, in full", async () => {
    const base = await setUp({ "a.ts": lines(5), "b.ts": lines(5) });
    await fixture.write({
      "a.ts": lines(5).replace("line 1\n", "A\n"),
      "b.ts": lines(5).replace("line 1\n", "B\n"),
    });
    const head = await fixture.commit("change both");
    const gone = "e".repeat(40);

    const diff = await reviewDiff(await clone(head, [base]), {
      baseSha: base,
      reviewedAt: new Map([["b.ts", gone]]),
    });
    expect(diff.kind).toBe("full");
    expect(diff.files.map((file) => file.path).toSorted()).toEqual(["a.ts", "b.ts"]);
    expect(diff.files[0]?.changedSinceLastReview).toBeUndefined();
    expect(diff.fallbackReason).toContain("couldn't compare incrementally");
  });

  it("reviews a file renamed since its last review in full, with its old name", async () => {
    await setUp({ "keep.txt": "k\n" });
    await fixture.write({ "src/auth.ts": lines(8, "auth") });
    const reviewed = await fixture.commit("add auth");
    await fixture.move("src/auth.ts", "src/security/auth.ts");
    const head = await fixture.commit("move it");

    const diff = await reviewDiff(await clone(head, [reviewed]), {
      baseSha: await fixture.git(["rev-parse", "main"]),
      reviewedAt: new Map([["src/auth.ts", reviewed]]),
    });
    expect(diff.files.map((file) => [file.path, file.alsoReviewedAs])).toEqual([
      ["src/security/auth.ts", ["src/auth.ts"]],
    ]);
    // Neither name is covered: both are recorded only once the file's batch succeeds.
    expect(diff.unchanged).toEqual([]);
  });

  it("shows what a file renamed back to an earlier name stopped adding", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.move("a.ts", "b.ts");
    await fixture.write({ "b.ts": lines(10).replace("line 3\n", "line 3\nrequireAdmin(user);\n") });
    const reviewed = await fixture.commit("rename, add the check");
    await fixture.move("b.ts", "a.ts");
    await fixture.write({ "a.ts": lines(10).replace("line 9\n", "line 9 edited\n") });
    const head = await fixture.commit("back to a.ts, check gone");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([
        ["a.ts", reviewed],
        ["b.ts", reviewed],
      ]),
    });
    const [file] = diff.files;
    expect(diff.files).toHaveLength(1);
    expect(file).toMatchObject({ path: "a.ts", alsoReviewedAs: ["b.ts"] });
    expect(file?.removedSinceLastReview).toContain("requireAdmin(user);");
    expect(diff.unchanged).toEqual([]);
  });

  it("never lets a renamed file with dropped lines count as only moved", async () => {
    const base = await setUp({ "a.ts": lines(20), "z.ts": lines(3) });
    await fixture.write({
      "a.ts": lines(20).replace("line 10\n", "line 10\nrequireAdmin(user);\n"),
    });
    const reviewed = await fixture.commit("add the check");
    // The check is dropped and the file renamed: against the base, a pure move.
    await fixture.write({ "a.ts": lines(20) });
    await fixture.move("a.ts", "b.ts");
    const head = await fixture.commit("drop it and move");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["a.ts", reviewed]]),
    });
    const [file] = diff.files;
    expect(file).toMatchObject({ path: "b.ts", moved: false, alsoReviewedAs: ["a.ts"] });
    expect(file?.removedSinceLastReview).toEqual(["requireAdmin(user);"]);
  });

  it("covers a gone-from-head path whose recorded commit is gone, without a fallback", async () => {
    const base = await setUp({ "keep.ts": lines(3) });
    await fixture.write({ "keep.ts": lines(4) });
    const head = await fixture.commit("edit keep.ts");

    const diff = await reviewDiff(await clone(head, [base]), {
      baseSha: base,
      reviewedAt: new Map([
        ["keep.ts", head],
        ["vanished.ts", "e".repeat(40)],
      ]),
    });
    expect(diff.unchanged.toSorted()).toEqual(["keep.ts", "vanished.ts"]);
    expect(diff.fallbackReason).toBeUndefined();
  });

  it("names an old name once", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.write({ "a.ts": lines(10).replace("line 2\n", "pr\n") });
    const reviewed = await fixture.commit("edit a.ts");
    await fixture.move("a.ts", "b.ts");
    const head = await fixture.commit("rename it");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["a.ts", reviewed]]),
    });
    expect(diff.files.map((file) => file.alsoReviewedAs)).toEqual([["a.ts"]]);
  });

  it("keeps what a reverted rename no longer adds when its old name is planned anyway", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.move("a.ts", "b.ts");
    await fixture.write({ "b.ts": lines(10).replace("line 3\n", "line 3\nrequireAdmin(user);\n") });
    const reviewed = await fixture.commit("rename, add the check");
    // b.ts goes; a.ts comes back rewritten (too different to count as the same file).
    await fixture.remove("b.ts");
    await fixture.write({ "a.ts": lines(10, "other") });
    const head = await fixture.commit("rewrite a.ts");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["b.ts", reviewed]]),
    });
    const [file] = diff.files;
    expect(diff.files).toHaveLength(1);
    expect(file).toMatchObject({ path: "a.ts", alsoReviewedAs: ["b.ts"] });
    // Exactly the dropped check, listed once.
    expect(file?.removedSinceLastReview).toEqual(["requireAdmin(user);"]);
  });

  it("lists a line reworded under a rename as one it no longer adds", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.write({
      "a.ts": lines(10).replace("line 5\n", "line 5\nlog('old wording here');\n"),
    });
    const reviewed = await fixture.commit("add a log");
    await fixture.write({
      "a.ts": lines(10).replace("line 5\n", "line 5\nlog('new wording here');\n"),
    });
    await fixture.move("a.ts", "b.ts");
    const head = await fixture.commit("reword and rename");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["a.ts", reviewed]]),
    });
    expect(diff.files[0]?.path).toBe("b.ts");
    // The old wording is listed; the new one shows as an added line.
    expect(diff.files[0]?.removedSinceLastReview).toEqual(["log('old wording here');"]);
  });

  it("compares a reverted rename's dropped lines with the planned file at its name", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.move("a.ts", "b.ts");
    await fixture.write({
      "b.ts": lines(10).replace("line 3\n", "line 3\nrequireAdmin(user);\nkeepThis(user);\n"),
    });
    const reviewed = await fixture.commit("rename, add two lines");
    // b.ts goes; a.ts comes back rewritten, still adding one of the two lines.
    await fixture.remove("b.ts");
    await fixture.write({ "a.ts": `${lines(10, "other")}keepThis(user);\n` });
    const head = await fixture.commit("rewrite a.ts");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["b.ts", reviewed]]),
    });
    const [file] = diff.files;
    expect(file?.path).toBe("a.ts");
    // Still added by a.ts, so not something the PR stopped adding.
    expect(file?.removedSinceLastReview).toEqual(["requireAdmin(user);"]);
  });

  it("says the review couldn't compare when every earlier commit is gone, for a move too", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.move("a.ts", "b.ts");
    const head = await fixture.commit("move only");

    const diff = await reviewDiff(await clone(head, [base]), {
      baseSha: base,
      reviewedAt: new Map([["b.ts", "e".repeat(40)]]),
    });
    expect(diff.files).toMatchObject([{ path: "b.ts", moved: true }]);
    expect(diff.kind).toBe("full");
    // No earlier review could be compared: the reason says so, without claiming a full read.
    expect(diff.fallbackReason).toContain("couldn't compare incrementally");
  });

  it("never takes a dropped guard for a rewording of a line elsewhere", async () => {
    const base = await setUp({ "a.ts": lines(30) });
    await fixture.write({
      "a.ts": lines(30).replace("line 5\n", "line 5\nif (!user.isAdmin) throw new Error('no');\n"),
    });
    const reviewed = await fixture.commit("add a guard");
    // The guard goes; an unrelated, similar check appears far away.
    await fixture.write({
      "a.ts": lines(30).replace("line 25\n", "line 25\nif (!user) throw new Error('no');\n"),
    });
    const head = await fixture.commit("drop it, add another");

    const [file] = (
      await reviewDiff(await clone(head, [base, reviewed]), {
        baseSha: base,
        reviewedAt: new Map([["a.ts", reviewed]]),
      })
    ).files;
    expect(file?.removedSinceLastReview).toEqual(["if (!user.isAdmin) throw new Error('no');"]);
  });

  it("never takes a dropped guard for a rewording, even in the same spot", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.write({
      "a.ts": lines(10).replace("line 5\n", "line 5\nrequireAdmin(user, 'billing');\n"),
    });
    const reviewed = await fixture.commit("add a guard");
    await fixture.write({
      "a.ts": lines(10).replace("line 5\n", "line 5\nrequireAdmin(user);\n"),
    });
    const head = await fixture.commit("loosen it");

    const [file] = (
      await reviewDiff(await clone(head, [base, reviewed]), {
        baseSha: base,
        reviewedAt: new Map([["a.ts", reviewed]]),
      })
    ).files;
    expect(file?.removedSinceLastReview).toEqual(["requireAdmin(user, 'billing');"]);
  });

  it("says nothing about a file the PR added and later deleted", async () => {
    const base = await setUp({ "keep.ts": lines(3) });
    await fixture.write({ "debug.ts": lines(5, "debug") });
    const reviewed = await fixture.commit("add debug.ts");
    await fixture.remove("debug.ts");
    await fixture.write({ "keep.ts": lines(4) });
    const head = await fixture.commit("drop it");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["debug.ts", reviewed]]),
    });
    expect(diff.noLongerChanged).toEqual([]);
    expect(diff.unchanged).toEqual(["debug.ts"]);
  });

  it("lists a dropped camelCase guard though a similar line stays", async () => {
    const base = await setUp({ "a.ts": lines(10) });
    await fixture.write({
      "a.ts": lines(10).replace(
        "line 5\n",
        "line 5\nif (!user.hasPermission('billing')) return;\n",
      ),
    });
    const reviewed = await fixture.commit("add a guard");
    await fixture.write({
      "a.ts": lines(10).replace("line 5\n", "line 5\nif (!user) return;\n"),
    });
    const head = await fixture.commit("weaken it");

    const [file] = (
      await reviewDiff(await clone(head, [base, reviewed]), {
        baseSha: base,
        reviewedAt: new Map([["a.ts", reviewed]]),
      })
    ).files;
    expect(file?.removedSinceLastReview).toEqual(["if (!user.hasPermission('billing')) return;"]);
  });

  it("counts copies: a line added twice and now once is listed once", async () => {
    const base = await setUp({ "a.ts": lines(20) });
    const twice = lines(20)
      .replace("line 5\n", "line 5\nassert(ok);\n")
      .replace("line 15\n", "line 15\nassert(ok);\n");
    await fixture.write({ "a.ts": twice });
    const reviewed = await fixture.commit("two asserts");
    await fixture.write({ "a.ts": lines(20).replace("line 5\n", "line 5\nassert(ok);\n") });
    const head = await fixture.commit("drop one");

    const [file] = (
      await reviewDiff(await clone(head, [base, reviewed]), {
        baseSha: base,
        reviewedAt: new Map([["a.ts", reviewed]]),
      })
    ).files;
    expect(file?.removedSinceLastReview).toEqual(["assert(ok);"]);
  });

  it("reviews a push that only deletes a base line, such as a check", async () => {
    const base = await setUp({
      "auth.ts": lines(10).replace("line 5\n", "if (!authorized) throw new Error('no');\n"),
    });
    await fixture.write({
      "auth.ts": lines(10)
        .replace("line 5\n", "if (!authorized) throw new Error('no');\n")
        .replace("line 9\n", "line 9 pr\n"),
    });
    const reviewed = await fixture.commit("an edit");
    // Only deletes the base's check.
    await fixture.write({
      "auth.ts": lines(10).replace("line 5\n", "").replace("line 9\n", "line 9 pr\n"),
    });
    const head = await fixture.commit("drop the check");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["auth.ts", reviewed]]),
    });
    const [file] = diff.files;
    expect(file?.path).toBe("auth.ts");
    // The deleted base line, on the old side.
    expect(file?.deletedSinceLastReview).toEqual([5]);
    expect(diff.unchanged).toEqual([]);
  });

  it("reviews a file the PR deletes again when the base content it deletes changed", async () => {
    await setUp({ "old.ts": lines(5), "keep.ts": lines(3) });
    await fixture.remove("old.ts");
    const reviewed = await fixture.commit("delete old.ts");
    // main changes the file the PR deletes, and the PR merges main.
    await fixture.checkout("main");
    await fixture.write({ "old.ts": lines(5).replace("line 2\n", "requireAdmin(user);\n") });
    const main = await fixture.commit("main edits old.ts");
    await fixture.checkout("pr");
    // Keeps the PR's deletion: the PR now deletes main's new version.
    await fixture.git(["merge", "--quiet", "--no-edit", "-s", "ours", main]);
    await fixture.git(["push", "--quiet", "--force", "--all", "origin"]);
    const head = await fixture.git(["rev-parse", "HEAD"]);

    const diff = await reviewDiff(await clone(head, [main, reviewed]), {
      baseSha: main,
      reviewedAt: new Map([["old.ts", reviewed]]),
    });
    expect(diff.files.map((file) => [file.path, file.status])).toEqual([["old.ts", "deleted"]]);
    expect(diff.files[0]?.deletedSinceLastReview).toEqual([2]);
  });

  it("treats a review commit with no history in common with the base as gone", async () => {
    const base = await setUp({ "a.ts": lines(5) });
    await fixture.write({ "a.ts": lines(5).replace("line 1\n", "A\n") });
    const head = await fixture.commit("change a");
    await fixture.git(["checkout", "--quiet", "--orphan", "unrelated"]);
    await fixture.write({ "x.txt": "x\n" });
    const orphan = await fixture.commit("unrelated history");

    const diff = await reviewDiff(await clone(head, [base, orphan]), {
      baseSha: base,
      reviewedAt: new Map([["a.ts", orphan]]),
    });
    expect(diff.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(diff.fallbackReason).toContain("couldn't compare");
  });

  it("has nothing to review when a pure rename is undone", async () => {
    const base = await setUp({ "a.ts": lines(10), "z.ts": lines(3) });
    await fixture.move("a.ts", "b.ts");
    const reviewed = await fixture.commit("rename only");
    await fixture.move("b.ts", "a.ts");
    await fixture.write({ "z.ts": lines(4) });
    const head = await fixture.commit("undo it, touch z.ts");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([["b.ts", reviewed]]),
    });
    expect(diff.files.map((file) => file.path)).toEqual(["z.ts"]);
    expect(diff.unchanged).toEqual(["b.ts"]);
  });

  it("leaves a renamed file alone once both its names are recorded", async () => {
    const base = await setUp({ "a.ts": lines(10), "z.ts": lines(3) });
    await fixture.move("a.ts", "b.ts");
    await fixture.write({ "b.ts": lines(10).replace("line 2\n", "edited\n") });
    const reviewed = await fixture.commit("rename and edit");
    await fixture.write({ "z.ts": lines(4) });
    const head = await fixture.commit("unrelated");

    // A run reviewed b.ts in full and recorded both names at its head.
    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: new Map([
        ["a.ts", reviewed],
        ["b.ts", reviewed],
      ]),
    });
    expect(diff.files.map((file) => file.path)).toEqual(["z.ts"]);
    expect(diff.unchanged.toSorted()).toEqual(["a.ts", "b.ts"]);
  });

  it("covers nothing of a rename whose earlier review is gone, and says so", async () => {
    const base = await setUp({ "old.ts": lines(10) });
    await fixture.move("old.ts", "new.ts");
    await fixture.write({ "new.ts": lines(10).replace("line 2\n", "edited\n") });
    const head = await fixture.commit("rename and edit");

    const diff = await reviewDiff(await clone(head, [base]), {
      baseSha: base,
      reviewedAt: new Map([["old.ts", "e".repeat(40)]]),
    });
    expect(diff.files.map((file) => [file.path, file.alsoReviewedAs])).toEqual([
      ["new.ts", ["old.ts"]],
    ]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.fallbackReason).toContain("couldn't compare incrementally");
  });

  it("lists a reverted rename once, and never both plans and covers a path", async () => {
    const base = await setUp({ "a.ts": lines(10), "z.ts": lines(3) });
    await fixture.move("a.ts", "b.ts");
    await fixture.write({ "b.ts": lines(10).replace("line 3\n", "line 3\ncheck();\n") });
    const reviewed = await fixture.commit("rename and add a check");
    await fixture.move("b.ts", "a.ts");
    await fixture.write({ "a.ts": lines(10), "z.ts": lines(4) });
    const head = await fixture.commit("undo it, touch z.ts");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      // Records for both names, as runs before and after the rename would leave.
      reviewedAt: new Map([
        ["a.ts", reviewed],
        ["b.ts", reviewed],
      ]),
    });
    const paths = diff.files.map((file) => file.path);
    // a.ts is back as the base has it: reported, not planned as an entry with no diff.
    expect(paths).toEqual(["z.ts"]);
    expect(diff.noLongerChanged).toEqual([{ path: "b.ts", lines: ["check();"] }]);
    expect(diff.unchanged.filter((path) => paths.includes(path))).toEqual([]);
  });

  it("covers a file the PR no longer changes whose last review is gone", async () => {
    const base = await setUp({ "a.ts": lines(5), "b.ts": lines(5) });
    await fixture.write({ "a.ts": lines(5).replace("line 1\n", "A\n") });
    const head = await fixture.commit("change a");

    const diff = await reviewDiff(await clone(head, [base]), {
      baseSha: base,
      reviewedAt: new Map([["b.ts", "e".repeat(40)]]),
    });
    // Re-recorded at this head, so the gone commit isn't asked for again.
    expect(diff.unchanged).toEqual(["b.ts"]);
    // No earlier review could be compared: the reason says so.
    expect(diff.fallbackReason).toContain("couldn't compare incrementally");
    expect(diff.files.map((file) => file.path)).toEqual(["a.ts"]);
  });

  it("doesn't call a file renamed since the last review reverted", async () => {
    const base = await setUp({ "keep.txt": "k\n" });
    await fixture.write({ "src/auth.ts": lines(8, "auth") });
    const reviewed = await fixture.commit("add auth");
    await fixture.move("src/auth.ts", "src/security/auth.ts");
    const head = await fixture.commit("move it");

    const diff = await reviewDiff(await clone(head, [base, reviewed]), {
      baseSha: base,
      reviewedAt: await reviewedAllAt(reviewed),
    });
    expect(diff.files.find((f) => f.path === "src/auth.ts")).toBeUndefined();
    expect(diff.files.flatMap((f) => f.removedSinceLastReview ?? [])).toEqual([]);
  });

  it("leaves blank lines and braces out of the removed lines, but not rewordings", async () => {
    const base = await setUp({ "a.ts": lines(30) });
    const draft = lines(30)
      .replace("line 5\n", "line 5\nfunction f() {\n  log('old wording');\n\n}\n")
      .replace("line 25\n", "line 25\nassertOwner(user);\n");
    await fixture.write({ "a.ts": draft });
    const reviewed = await fixture.commit("draft");
    await fixture.write({
      "a.ts": draft
        .replace("  log('old wording');\n\n}", "  log('new wording');")
        .replace("assertOwner(user);\n", ""),
    });
    const head = await fixture.commit("tidy");

    const [file] = (
      await reviewDiff(await clone(head, [base, reviewed]), {
        baseSha: base,
        reviewedAt: await reviewedAllAt(reviewed),
      })
    ).files;
    // Blank lines and braces say nothing; a reworded line is listed with the dropped one.
    expect(file?.removedSinceLastReview?.toSorted()).toEqual([
      "  log('old wording');",
      "assertOwner(user);",
    ]);
  });

  it("still reports a check swapped for an unrelated line in the same spot", async () => {
    const base = await setUp({ "a.ts": lines(20) });
    const draft = lines(20).replace("line 10\n", "line 10\nrequireAdmin(user);\n");
    await fixture.write({ "a.ts": draft });
    const reviewed = await fixture.commit("add check");
    await fixture.write({
      "a.ts": draft.replace("requireAdmin(user);", "logger.info(request.id);"),
    });
    const head = await fixture.commit("swap it");

    const [file] = (
      await reviewDiff(await clone(head, [base, reviewed]), {
        baseSha: base,
        reviewedAt: await reviewedAllAt(reviewed),
      })
    ).files;
    expect(file?.removedSinceLastReview).toEqual(["requireAdmin(user);"]);
    expect(file?.changedSinceLastReview).toEqual([11]);
  });

  it("includes files renamed or deleted since the last review, and nothing when head is unchanged", async () => {
    const base = await setUp({ "a.txt": lines(10), "b.txt": lines(10, "b") });
    await fixture.write({
      "a.txt": lines(10).replace("line 1\n", "x\n"),
      "b.txt": lines(10, "b").replace("b 1\n", "y\n"),
    });
    const reviewed = await fixture.commit("edits");
    await fixture.remove("a.txt");
    await fixture.move("b.txt", "c.txt");
    const head = await fixture.commit("delete and rename");

    const repo = await clone(head, [base, reviewed]);
    const files = byPath(
      (await reviewDiff(repo, { baseSha: base, reviewedAt: await reviewedAllAt(reviewed) })).files,
    );
    expect(files["a.txt"]).toMatchObject({ status: "deleted", changedSinceLastReview: [] });
    expect(files["c.txt"]).toMatchObject({ status: "renamed", oldPath: "b.txt" });
    expect(
      (await reviewDiff(repo, { baseSha: base, reviewedAt: await reviewedAllAt(head) })).files,
    ).toEqual([]);
  });
});
