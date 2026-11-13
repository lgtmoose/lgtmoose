import { glob, open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DEFAULT_CONVENTIONS } from "@lgtmoose/config";

/** A repo convention file (`CLAUDE.md`, `AGENTS.md`, ...), with its path relative to the repo. */
export interface ConventionFile {
  path: string;
  text: string;
  /** The file was longer than the limit and was cut. */
  truncated?: boolean;
}

export interface ReadConventionsOptions {
  /** Globs relative to the checkout. Defaults to `DEFAULT_CONVENTIONS` from @lgtmoose/config. */
  globs?: readonly string[];
  /** Most bytes read from one file. Defaults to 64 KiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

/** Whether a glob stays inside the checkout: relative, with no `..` segment. */
function isSafeGlob(pattern: string): boolean {
  return (
    pattern !== "" && !isAbsolute(pattern) && !pattern.split(/[\\/]/).some((part) => part === "..")
  );
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function readCapped(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    // Cutting can split a multi-byte character; the decoder replaces the stray bytes.
    const text = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the repo's convention files from a checkout. The checkout is PR code, so this is
 * careful about what it opens: globs that leave the checkout are ignored, symlinks are skipped,
 * and so is anything whose real path is outside the checkout. Results are sorted by path.
 */
export async function readConventionFiles(
  checkoutDir: string,
  { globs = DEFAULT_CONVENTIONS, maxBytes = DEFAULT_MAX_BYTES }: ReadConventionsOptions = {},
): Promise<ConventionFile[]> {
  const root = await realpath(checkoutDir);
  const paths = new Set<string>();
  for (const pattern of globs.filter(isSafeGlob)) {
    for await (const match of glob(pattern, { cwd: root })) paths.add(match.split(sep).join("/"));
  }

  const files: ConventionFile[] = [];
  for (const path of [...paths].sort()) {
    const full = join(root, path);
    const stat = await lstat(full);
    if (!stat.isFile()) continue;
    // Catches a symlinked parent folder, which lstat on the file itself doesn't see.
    if (!isInside(root, await realpath(full))) continue;
    const { text, truncated } = await readCapped(full, maxBytes);
    files.push(truncated ? { path, text, truncated } : { path, text });
  }
  return files;
}
