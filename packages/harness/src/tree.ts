import type { Dirent } from "node:fs";
import { opendir } from "node:fs/promises";
import { sep } from "node:path";

/**
 * One entry the walk found. Paths are the raw bytes the filesystem holds, so a name that isn't
 * valid UTF-8 (which a PR can commit) still reaches the right file; `name` and `relText` are
 * decoded for matching and logging only, with invalid bytes replaced.
 */
export interface TreeEntry {
  entry: Dirent<Buffer>;
  /** The entry's name, decoded. */
  name: string;
  /** Its full path, as bytes: pass this to fs calls. */
  path: Buffer;
  /** Its path relative to the walk's root, as bytes. */
  rel: Buffer;
  /** `rel`, decoded. */
  relText: string;
}

export interface WalkOptions {
  /**
   * Called for a directory below the root that can't be opened for lack of permission, which is
   * then left out. Without it, that error is thrown. A directory that's gone is always skipped.
   */
  onUnreadable?: (path: Buffer, error: unknown) => void;
}

function code(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

/** The entry is gone: it was removed or replaced while the walk ran. */
export function isGone(error: unknown): boolean {
  const c = code(error);
  return c === "ENOENT" || c === "ENOTDIR";
}

/** Errors that mean "this one entry can't be read", not "the walk is broken". */
export function isUnreadable(error: unknown): boolean {
  const c = code(error);
  return c === "EACCES" || c === "EPERM" || isGone(error);
}

const SEP = Buffer.from(sep);

/** `base` and `name` joined, as bytes. */
export function joinBytes(base: Buffer, name: Buffer): Buffer {
  return base.length === 0 ? name : Buffer.concat([base, SEP, name]);
}

/**
 * Walks the tree under `root` depth first, one directory entry at a time, calling `visit` for
 * every entry. It never follows symlinks: a link is reported as a link, never entered. `visit`
 * returns "skip" to leave a directory out of the walk. Names are read as raw bytes, and a
 * directory that vanishes mid-walk is skipped.
 */
export async function walkTree(
  root: string,
  visit: (item: TreeEntry) => Promise<"skip" | undefined> | "skip" | undefined,
  options: WalkOptions = {},
): Promise<void> {
  const rootBytes = Buffer.from(root);
  const walk = async (dir: Buffer, rel: Buffer): Promise<void> => {
    let handle;
    try {
      handle = await opendir(dir, { encoding: "buffer" } as unknown as { encoding: "utf8" });
    } catch (error) {
      if (dir === rootBytes) throw error;
      if (isGone(error)) return;
      if (options.onUnreadable === undefined || !isUnreadable(error)) throw error;
      options.onUnreadable(dir, error);
      return;
    }
    for await (const found of handle) {
      const entry = found as unknown as Dirent<Buffer>;
      const name = entry.name;
      const entryRel = joinBytes(rel, name);
      const path = joinBytes(dir, name);
      const decision = await visit({
        entry,
        name: name.toString("utf8"),
        path,
        rel: entryRel,
        relText: entryRel.toString("utf8"),
      });
      if (entry.isDirectory() && decision !== "skip") await walk(path, entryRel);
    }
  };
  await walk(rootBytes, Buffer.alloc(0));
}
