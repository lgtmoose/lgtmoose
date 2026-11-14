import { copyFile, mkdir, opendir, readlink, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { isInside } from "../paths.js";

/**
 * Directories left out of the copy the CLI runs on, at any depth:
 * - `.git`: the model has no shell, so git data is only something to read by accident;
 * - `.cursor`: hooks (commands the CLI runs itself, outside the tool deny rules, with the key in
 *   their environment), `cli.json`, `mcp.json`, `sandbox.json` and rules, all PR content that a
 *   trusted workspace would load (https://cursor.com/docs/agent/hooks);
 * - `.claude`: Claude Code settings, whose hooks Cursor can load too.
 */
export const CURSOR_SKIPPED_DIRS: readonly string[] = [".git", ".cursor", ".claude"];

/**
 * Instruction files Cursor applies as always-on rules, at any depth (it reads nested ones too).
 * Claude Code runs with CLAUDE.md off; Cursor has no switch for it, so these stay out of the copy.
 * Their diff is still in the prompt, as untrusted PR content, which is how the reviewer should
 * see them.
 */
export const CURSOR_SKIPPED_FILES: readonly string[] = [
  "agents.md",
  "claude.md",
  "claude.local.md",
  ".cursorrules",
];

/**
 * Copies the checkout at `source` into `dest` (which must not exist) for the CLI to run in,
 * leaving out `CURSOR_SKIPPED_DIRS` and `CURSOR_SKIPPED_FILES`, and every symlink that doesn't
 * resolve inside the checkout. The caller's tree is never changed. Symlinks are copied as links
 * and directories are walked one entry at a time, without following links.
 */
export async function copyWorkspace(source: string, dest: string): Promise<void> {
  const root = await realpath(source);
  await mkdir(dest);
  const walk = async (from: string, to: string): Promise<void> => {
    const dir = await opendir(from);
    for await (const entry of dir) {
      const name = entry.name;
      const src = join(from, name);
      const out = join(to, name);
      if (entry.isDirectory()) {
        if (CURSOR_SKIPPED_DIRS.includes(name)) continue;
        await mkdir(out);
        await walk(src, out);
      } else if (entry.isFile()) {
        if (CURSOR_SKIPPED_FILES.includes(name.toLowerCase())) continue;
        await copyFile(src, out);
      } else if (entry.isSymbolicLink()) {
        if (CURSOR_SKIPPED_FILES.includes(name.toLowerCase())) continue;
        const target = await realpath(src).catch(() => undefined);
        if (target === undefined || !isInside(root, target)) continue;
        await symlink(await readlink(src), out);
      }
      // Sockets, FIFOs and devices aren't review material.
    }
  };
  await walk(root, dest);
}
