import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

  it("keeps links that resolve inside the checkout, as links, and drops the rest", async () => {
    await mkdir(join(source, "docs"));
    await writeFile(join(source, "README.md"), "hi");
    await symlink("../README.md", join(source, "docs", "readme"));
    await symlink("../../secret", join(source, "docs", "up"));
    await symlink("/proc/self/environ", join(source, "docs", "env"));
    await symlink("missing", join(source, "docs", "gone"));
    await copyWorkspace(source, dest);
    expect(await readdir(join(dest, "docs"))).toEqual(["readme"]);
    expect(await readlink(join(dest, "docs", "readme"))).toBe("../README.md");
  });

  it("doesn't follow a directory link while walking", async () => {
    await mkdir(join(source, "real"));
    await writeFile(join(source, "real", "a.ts"), "");
    await symlink("real", join(source, "alias"));
    await copyWorkspace(source, dest);
    expect((await readdir(dest)).sort()).toEqual(["alias", "real"]);
    expect((await lstat(join(dest, "alias"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dest, "alias"))).toBe("real");
    expect(await readdir(join(dest, "real"))).toEqual(["a.ts"]);
  });
});
