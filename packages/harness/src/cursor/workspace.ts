import { constants } from "node:fs";
import { copyFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isUnreadable, walkTree } from "../tree.js";

/**
 * Directories left out of the copy the CLI runs on, at any depth, compared without case:
 * - `.git`: the model has no shell, so git data is only something to read by accident;
 * - `.cursor`: hooks (commands the CLI runs itself, outside the tool deny rules, with the key in
 *   their environment), `cli.json`, `mcp.json`, `sandbox.json` and rules, all PR content that a
 *   trusted workspace would load (https://cursor.com/docs/agent/hooks);
 * - `.claude`: Claude Code settings, whose hooks Cursor can load too;
 * - `node_modules`: installed dependencies, not the change, and often most of a working tree's
 *   files when the harness runs outside the sandbox (whose checkout comes from git).
 */
export const CURSOR_SKIPPED_DIRS: readonly string[] = [
  ".git",
  ".cursor",
  ".claude",
  "node_modules",
];

/**
 * Files left out, at any depth, compared without case: instruction files Cursor applies as
 * always-on rules (Claude Code runs with CLAUDE.md off; Cursor has no switch for it), and the
 * ignore files that would let PR content hide files, the run's task file included, from the
 * model. Their diff is still in the prompt, as untrusted PR content, which is how the reviewer
 * should see them.
 */
export const CURSOR_SKIPPED_FILES: readonly string[] = [
  "agents.md",
  "claude.md",
  "claude.local.md",
  ".cursorrules",
  ".cursorignore",
  ".cursorindexingignore",
];

/** What the copy left out that the caller may want to report. */
export interface WorkspaceCopy {
  /** Symlinks, none of which are copied. */
  links: number;
  /** Files and directories that couldn't be read. */
  unreadable: number;
}

/**
 * Copies the checkout at `source` into `dest` (which must not exist) for the CLI to run in,
 * leaving out `CURSOR_SKIPPED_DIRS`, `CURSOR_SKIPPED_FILES` and every symlink: a link, wherever it
 * points, can lead back into a skipped config directory or to the original checkout, and the
 * model gets file contents from the prompt anyway. Unreadable entries are left out and counted.
 * The caller's tree is never changed.
 */
export async function copyWorkspace(source: string, dest: string): Promise<WorkspaceCopy> {
  const root = await realpath(source);
  await mkdir(dest);
  const copy: WorkspaceCopy = { links: 0, unreadable: 0 };
  await walkTree(
    root,
    async ({ entry, path, rel }) => {
      const name = entry.name.toLowerCase();
      const out = join(dest, rel);
      if (entry.isDirectory()) {
        if (CURSOR_SKIPPED_DIRS.includes(name)) return "skip";
        await mkdir(out);
      } else if (entry.isSymbolicLink()) {
        copy.links += 1;
      } else if (entry.isFile() && !CURSOR_SKIPPED_FILES.includes(name)) {
        // A copy-on-write clone where the filesystem has them, else a plain copy.
        await copyFile(path, out, constants.COPYFILE_FICLONE).catch((error: unknown) => {
          if (!isUnreadable(error)) throw error;
          copy.unreadable += 1;
        });
      }
      // Sockets, FIFOs and devices aren't review material.
      return undefined;
    },
    { onUnreadable: () => (copy.unreadable += 1) },
  );
  return copy;
}
