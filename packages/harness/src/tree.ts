import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";

/** One entry the walk found, with its path absolute and relative to the walk's root. */
export interface TreeEntry {
  entry: Dirent;
  path: string;
  rel: string;
}

export interface WalkOptions {
  /**
   * Called for a directory below the root that can't be opened (no permission, or gone), which
   * is then left out. Without it, the error is thrown.
   */
  onUnreadable?: (path: string, error: unknown) => void;
}

/** Errors that mean "this one entry can't be read", not "the walk is broken". */
export function isUnreadable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

/**
 * Walks the tree under `root` depth first, one directory entry at a time, calling `visit` for
 * every entry. It never follows symlinks: a link is reported as a link, never entered. `visit`
 * returns "skip" to leave a directory out of the walk.
 */
export async function walkTree(
  root: string,
  visit: (item: TreeEntry) => Promise<"skip" | undefined> | "skip" | undefined,
  options: WalkOptions = {},
): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    let handle;
    try {
      handle = await opendir(dir);
    } catch (error) {
      if (dir === root || options.onUnreadable === undefined || !isUnreadable(error)) throw error;
      options.onUnreadable(dir, error);
      return;
    }
    for await (const entry of handle) {
      const path = join(dir, entry.name);
      const decision = await visit({ entry, path, rel: relative(root, path) });
      if (entry.isDirectory() && decision !== "skip") await walk(path);
    }
  };
  await walk(root);
}
