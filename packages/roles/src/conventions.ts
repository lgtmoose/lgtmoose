import { glob, open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, join, matchesGlob, relative, sep } from "node:path";
import { DEFAULT_CONVENTIONS } from "@lgtmoose/config";
import type { Repo } from "@lgtmoose/git";

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
  /** Most files read. Defaults to 20. */
  maxFiles?: number;
  /** Most bytes read across all files. Defaults to 128 KiB. */
  maxTotalBytes?: number;
}

/** The convention files read, and the matching paths left out to stay within the limits. */
export interface ConventionFiles {
  files: ConventionFile[];
  omitted: string[];
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024;

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
 *
 * Every file goes into every reviewer prompt, so the number of files and the total size are
 * capped as well as each file's size; a broad glob can't fill the model's context. Paths past
 * the limits are listed in `omitted`.
 */
export async function readConventionFiles(
  checkoutDir: string,
  {
    globs = DEFAULT_CONVENTIONS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  }: ReadConventionsOptions = {},
): Promise<ConventionFiles> {
  const root = await realpath(checkoutDir);
  const paths = new Set<string>();
  for (const pattern of globs.filter(isSafeGlob)) {
    for await (const match of glob(pattern, { cwd: root })) paths.add(match.split(sep).join("/"));
  }

  const files: ConventionFile[] = [];
  const omitted: string[] = [];
  let remaining = maxTotalBytes;
  for (const path of [...paths].sort()) {
    const full = join(root, path);
    const stat = await lstat(full);
    if (!stat.isFile()) continue;
    // Catches a symlinked parent folder, which lstat on the file itself doesn't see.
    if (!isInside(root, await realpath(full))) continue;
    if (files.length >= maxFiles || remaining <= 0) {
      omitted.push(path);
      continue;
    }
    const { text, truncated } = await readCapped(full, Math.min(maxBytes, remaining));
    if (files.some((file) => file.text === text)) {
      omitted.push(path);
      continue;
    }
    remaining -= Buffer.byteLength(text, "utf8");
    files.push(truncated ? { path, text, truncated } : { path, text });
  }
  return { files, omitted };
}

/** A regular file in a git tree: a blob with a normal file mode (not a symlink or submodule). */
export const REGULAR_FILE = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/;

/** Code-unit order for paths, so it doesn't depend on the locale. */
export function byCodeUnit(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}

/**
 * Reads the repo's convention files as they are at a commit, such as the PR's base, from git
 * rather than a checkout: the PR can't change the rules it's reviewed against. Only regular
 * files count (symlinks and submodules in the tree are ignored), with the same globs, limits
 * and `omitted` list as `readConventionFiles`. Results are sorted by path.
 */
export async function readConventionFilesAt(
  repo: Pick<Repo, "git" | "readBlobs">,
  sha: string,
  {
    globs = DEFAULT_CONVENTIONS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  }: ReadConventionsOptions = {},
): Promise<ConventionFiles> {
  const patterns = globs.filter(isSafeGlob);
  const tree = await repo.git(["ls-tree", "-r", "-z", "--full-tree", sha]);
  const matches: { path: string; blob: string }[] = [];
  for (const entry of tree.split("\0")) {
    const parsed = REGULAR_FILE.exec(entry);
    const [, , blob, path] = parsed ?? [];
    if (blob === undefined || path === undefined) continue;
    if (patterns.some((pattern) => matchesGlob(path, pattern))) matches.push({ path, blob });
  }
  // Code-unit order, as readConventionFiles sorts, so it doesn't depend on the locale.
  matches.sort((a, b) => byCodeUnit(a.path, b.path));

  const wanted = matches.slice(0, maxFiles);
  const blobs = await repo.readBlobs(wanted.map((match) => match.blob));
  const files: ConventionFile[] = [];
  const omitted = matches.slice(maxFiles).map((match) => match.path);
  let remaining = maxTotalBytes;
  for (const { path, blob } of wanted) {
    const content = blobs.get(blob);
    if (content === undefined) continue;
    if (remaining <= 0) {
      omitted.push(path);
      continue;
    }
    const limit = Math.min(maxBytes, remaining);
    const truncated = content.length > limit;
    // Cutting can split a multi-byte character; the decoder replaces the stray bytes.
    const text = content.subarray(0, limit).toString("utf8");
    if (files.some((file) => file.text === text)) {
      omitted.push(path);
      continue;
    }
    remaining -= Buffer.byteLength(text, "utf8");
    files.push(truncated ? { path, text, truncated } : { path, text });
  }
  omitted.sort();
  return { files, omitted };
}
