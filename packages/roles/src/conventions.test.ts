import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConventionFiles, type ReadConventionsOptions } from "./conventions.js";

async function read(options?: ReadConventionsOptions) {
  return (await readConventionFiles(checkout, options)).files;
}

let root: string;
let checkout: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lgtmoose-roles-"));
  checkout = join(root, "repo");
  await mkdir(join(checkout, ".cursor", "rules"), { recursive: true });
  await mkdir(join(checkout, ".github"), { recursive: true });
  await writeFile(join(root, "secret.txt"), "TOKEN=hunter2");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("readConventionFiles", () => {
  it("reads the default convention files, sorted by path", async () => {
    await writeFile(join(checkout, "CLAUDE.md"), "Use pnpm.");
    await writeFile(join(checkout, "AGENTS.md"), "No nested ternaries.");
    await writeFile(join(checkout, ".github", "copilot-instructions.md"), "Short sentences.");
    await writeFile(join(checkout, ".cursor", "rules", "labels.mdc"), "One label.");
    await writeFile(join(checkout, ".cursor", "rules", "notes.txt"), "Not a rule.");
    expect(await read()).toEqual([
      { path: ".cursor/rules/labels.mdc", text: "One label." },
      { path: ".github/copilot-instructions.md", text: "Short sentences." },
      { path: "AGENTS.md", text: "No nested ternaries." },
      { path: "CLAUDE.md", text: "Use pnpm." },
    ]);
  });

  it("omits a file whose text is the same as one already read", async () => {
    await writeFile(join(checkout, "AGENTS.md"), "One label.\n");
    await writeFile(join(checkout, "CLAUDE.md"), "One label.\n");
    await writeFile(join(checkout, ".github", "copilot-instructions.md"), "One label.\n");
    const result = await readConventionFiles(checkout, {
      globs: ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"],
    });
    expect(result.files).toEqual([
      { path: ".github/copilot-instructions.md", text: "One label.\n" },
    ]);
    expect(result.omitted).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("gives an empty list when there are none", async () => {
    expect(await read()).toEqual([]);
  });

  it("skips symlinks, including symlinked folders", async () => {
    await symlink(join(root, "secret.txt"), join(checkout, "CLAUDE.md"));
    await rm(join(checkout, ".cursor"), { recursive: true });
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "x.mdc"), "outside");
    await symlink(join(root, "outside"), join(checkout, ".cursor"));
    expect(await read({ globs: ["CLAUDE.md", ".cursor/*.mdc"] })).toEqual([]);
  });

  it("ignores globs that leave the checkout", async () => {
    const files = await read({
      globs: ["../secret.txt", join(root, "secret.txt"), "a/../../secret.txt"],
    });
    expect(files).toEqual([]);
  });

  it("cuts files longer than the limit", async () => {
    await writeFile(join(checkout, "AGENTS.md"), "abcdefghij");
    expect(await read({ globs: ["AGENTS.md"], maxBytes: 4 })).toEqual([
      { path: "AGENTS.md", text: "abcd", truncated: true },
    ]);
  });

  it("caps the number of files and lists the rest as omitted", async () => {
    for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(checkout, name), name);
    expect(await readConventionFiles(checkout, { globs: ["*.md"], maxFiles: 2 })).toEqual({
      files: [
        { path: "a.md", text: "a.md" },
        { path: "b.md", text: "b.md" },
      ],
      omitted: ["c.md"],
    });
  });

  it("caps the total size across files", async () => {
    await writeFile(join(checkout, "a.md"), "123456");
    await writeFile(join(checkout, "b.md"), "abcdef");
    await writeFile(join(checkout, "c.md"), "xyz");
    expect(await readConventionFiles(checkout, { globs: ["*.md"], maxTotalBytes: 8 })).toEqual({
      files: [
        { path: "a.md", text: "123456" },
        { path: "b.md", text: "ab", truncated: true },
      ],
      omitted: ["c.md"],
    });
  });
});
