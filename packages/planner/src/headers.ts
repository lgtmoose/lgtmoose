import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { FileDiff, Repo } from "@lgtmoose/git";
import type { RepoConfig } from "@lgtmoose/config";
import { headerHasMarker, includeMatcher, skipClassifier, type FileHeaders } from "./classify.js";

/** How much of each blob is kept: enough for the first few lines of a header. */
const HEADER_BYTES = 2048;

/** How many head files are open at once, well under common file-descriptor limits. */
const READ_CONCURRENCY = 64;

/** Errors that mean the path has no readable regular file, not that reading failed. */
const NO_FILE = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/** The first bytes of a regular file in the checkout, or undefined (missing, symlink, ...). */
async function readHead(dir: string, path: string): Promise<string | undefined> {
  const full = join(dir, path);
  try {
    if (!(await lstat(full)).isFile()) return undefined;
    const handle = await open(full, "r");
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Anything else (EMFILE, EACCES, EIO) would silently turn off generated detection.
    if (NO_FILE.has((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

function keep(headers: Map<string, string>, blobs: Map<string, Buffer>): void {
  for (const [sha, content] of blobs) {
    headers.set(sha, content.subarray(0, HEADER_BYTES).toString("utf8"));
  }
}

/**
 * Reads the first lines of the files whose header can decide whether they're generated, for
 * `planReview`'s `headers` option. Only existing text files that the skip globs don't already
 * skip need it (a marker on a file the PR adds doesn't count). Head sides are read from the
 * working tree, only their first bytes; a base side is fetched only when its head has a marker.
 *
 * It only reads. The head files must already be on disk: a full checkout, or the caller ran
 * `checkoutPaths` for these files first (which the review needs anyway). A file that isn't there
 * gets no header, and generated detection falls back to its hunks.
 *
 * `config` is the repo's config from the base commit, as given to `planReview`. Files its
 * `skip` globs skip need no header, and nor do files its `include` globs match, since an
 * include turns the generated-header check off.
 */
export async function readHeaders(
  repo: Pick<Repo, "dir" | "readBlobs">,
  files: readonly FileDiff[],
  config: Partial<Pick<RepoConfig, "skip" | "include">> = {},
): Promise<FileHeaders> {
  const include = config.include ?? [];
  const skipByGlob = skipClassifier(config.skip ?? [], undefined, include);
  const isIncluded = includeMatcher(include);
  const candidates = files.filter(
    (file) =>
      !file.binary &&
      !file.submodule &&
      file.status !== "added" &&
      file.oldBlob !== undefined &&
      file.newBlob !== undefined &&
      !isIncluded(file.path) &&
      skipByGlob(file) === undefined,
  );
  const headers = new Map<string, string>();
  if (candidates.length === 0) return headers;

  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    await Promise.all(
      candidates.slice(i, i + READ_CONCURRENCY).map(async (file) => {
        const head = await readHead(repo.dir, file.path);
        if (head !== undefined && file.newBlob !== undefined) headers.set(file.newBlob, head);
      }),
    );
  }

  const bases = candidates.flatMap((file) => {
    const head = file.newBlob === undefined ? undefined : headers.get(file.newBlob);
    return head !== undefined && headerHasMarker(head) && file.oldBlob !== undefined
      ? [file.oldBlob]
      : [];
  });
  if (bases.length > 0) keep(headers, await repo.readBlobs(bases));
  return headers;
}
