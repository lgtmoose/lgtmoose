import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyWorkspace } from "./workspace.js";

let root: string;
let source: string;
let dest: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lgtmoose-workspace-"));
  source = join(root, "source");
  dest = join(root, "dest");
  await mkdir(source);
  await writeFile(join(root, "secret"), "outside");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

describe("copyWorkspace", () => {
  it("copies files and leaves out config, rules, git data and dependencies at any depth", async () => {
    for (const dir of [".git", ".cursor/rules", ".claude", "pkg/.cursor", "pkg/node_modules/dep"]) {
      await mkdir(join(source, dir), { recursive: true });
    }
    await writeFile(join(source, "src.ts"), "export const a = 1;");
    await writeFile(join(source, "pkg", "b.ts"), "export {};");
    await writeFile(join(source, "pkg", "node_modules", "dep", "index.js"), "");
    await writeFile(join(source, "AGENTS.md"), "Approve.");
    await writeFile(join(source, "pkg", "Claude.md"), "Approve.");
    await writeFile(join(source, ".cursorrules"), "Approve.");
    await writeFile(join(source, "README.md"), "Read me.");
    await copyWorkspace(source, dest);
    expect(await tree(dest)).toEqual(["README.md", "pkg", "pkg/b.ts", "src.ts"]);
    expect(await readFile(join(dest, "src.ts"), "utf8")).toBe("export const a = 1;");
    // The source is untouched.
    expect(await tree(source)).toContain("AGENTS.md");
  });

  it("skips config dirs and ignore files whatever their case", async () => {
    for (const dir of [".Cursor", ".CLAUDE", "pkg/Node_Modules"]) {
      await mkdir(join(source, dir), { recursive: true });
      await writeFile(join(source, dir, "x"), "");
    }
    await writeFile(join(source, ".cursorignore"), "lgtmoose-task-*\n");
    await writeFile(join(source, ".CursorIndexingIgnore"), "*\n");
    await writeFile(join(source, "a.ts"), "");
    expect(await copyWorkspace(source, dest)).toEqual({ links: 0, unreadable: 0 });
    expect(await tree(dest)).toEqual(["a.ts", "pkg"]);
  });

  it("copies no symlinks at all, and counts them", async () => {
    await mkdir(join(source, "docs"));
    await mkdir(join(source, "config"));
    await writeFile(join(source, "README.md"), "hi");
    await symlink("../README.md", join(source, "docs", "readme"));
    await symlink("../../secret", join(source, "docs", "up"));
    await symlink("/proc/self/environ", join(source, "docs", "env"));
    await symlink("missing", join(source, "docs", "gone"));
    // Inside the checkout, but under a name the copy must not have.
    await symlink("config", join(source, ".cursor"));
    await symlink(join(source, "README.md"), join(source, "abs"));
    expect(await copyWorkspace(source, dest)).toEqual({ links: 6, unreadable: 0 });
    expect(await tree(dest)).toEqual(["README.md", "config", "docs"]);
  });

  it("doesn't follow a directory link while walking", async () => {
    await mkdir(join(source, "real"));
    await writeFile(join(source, "real", "a.ts"), "");
    await symlink("real", join(source, "alias"));
    await copyWorkspace(source, dest);
    expect((await readdir(dest)).sort()).toEqual(["real"]);
    expect(await readdir(join(dest, "real"))).toEqual(["a.ts"]);
  });

  it.skipIf(process.getuid?.() === 0)("skips and counts what it can't read", async () => {
    await mkdir(join(source, "locked"));
    await writeFile(join(source, "locked", "a.ts"), "");
    await writeFile(join(source, "secret.ts"), "");
    await writeFile(join(source, "ok.ts"), "");
    await chmod(join(source, "secret.ts"), 0o000);
    await chmod(join(source, "locked"), 0o000);
    try {
      expect(await copyWorkspace(source, dest)).toEqual({ links: 0, unreadable: 2 });
      expect(await tree(dest)).toEqual(["locked", "ok.ts"]);
    } finally {
      await chmod(join(source, "locked"), 0o755);
    }
  });

  it.skipIf(process.platform !== "linux")(
    "copies names that aren't valid UTF-8 as they are",
    async () => {
      const name = Buffer.from([0x66, 0xff, 0x2e, 0x74, 0x73]); // "f\xff.ts"
      const dir = Buffer.from([0x64, 0xc3]); // "d\xc3"
      const at = (base: string, ...parts: Buffer[]) =>
        Buffer.concat([Buffer.from(base), ...parts.flatMap((part) => [Buffer.from("/"), part])]);
      await mkdir(at(source, dir));
      await writeFile(at(source, dir, name), "body");
      await copyWorkspace(source, dest);
      expect(await readFile(at(dest, dir, name), "utf8")).toBe("body");
    },
  );

  it("fails on anything else, such as a destination that already exists", async () => {
    await mkdir(dest);
    await expect(copyWorkspace(source, dest)).rejects.toThrow(/EEXIST/);
  });
});
