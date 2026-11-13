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
      lastReviewed: reviewed,
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
      lastReviewed: reviewed,
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
      lastReviewed: reviewed,
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
      lastReviewed: reviewed,
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
          lastReviewed: reviewed,
        })
      ).files,
    );
    expect(files["auth.ts"]?.removedSinceLastReview).toEqual(["requireAdmin(user);"]);
    // Fully reverted: no longer in the PR diff, but what it took out is still worth a mention.
    expect(files["other.ts"]).toMatchObject({ hunks: [], removedSinceLastReview: ["temporary"] });
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
    const files = byPath((await reviewDiff(repo, { baseSha: base, lastReviewed: reviewed })).files);
    expect(files["a.txt"]).toMatchObject({ status: "deleted", changedSinceLastReview: [] });
    expect(files["c.txt"]).toMatchObject({ status: "renamed", oldPath: "b.txt" });
    expect((await reviewDiff(repo, { baseSha: base, lastReviewed: head })).files).toEqual([]);
  });
});
