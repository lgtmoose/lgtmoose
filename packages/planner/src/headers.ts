import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { FileDiff, Repo } from "@lgtmoose/git";
import { headerHasMarker, skipClassifier, type FileHeaders } from "./classify.js";

/** How much of each blob is kept: enough for the first few lines of a header. */
const HEADER_BYTES = 2048;

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
  } catch {
    return undefined;
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
 * working tree, only their first bytes (with `checkout: "none"`, the paths are checked out
 * first, which the review needs anyway); a base side is fetched only when its head has a marker.
 *
 * `configSkip` is the repo's `skip` globs, from the base commit, as given to `planReview`.
 */
export async function readHeaders(
  repo: Pick<Repo, "dir" | "readBlobs" | "fullCheckout" | "checkoutPaths">,
  files: readonly FileDiff[],
  configSkip: readonly string[] = [],
): Promise<FileHeaders> {
  const skipByGlob = skipClassifier(configSkip);
  const candidates = files.filter(
    (file) =>
      !file.binary &&
      !file.submodule &&
      file.status !== "added" &&
      file.oldBlob !== undefined &&
      file.newBlob !== undefined &&
      skipByGlob(file) === undefined,
  );
  const headers = new Map<string, string>();
  if (candidates.length === 0) return headers;

  if (!repo.fullCheckout) await repo.checkoutPaths(candidates.map((file) => file.path));
  await Promise.all(
    candidates.map(async (file) => {
      const head = await readHead(repo.dir, file.path);
      if (head !== undefined && file.newBlob !== undefined) headers.set(file.newBlob, head);
    }),
  );

  const bases = candidates.flatMap((file) => {
    const head = file.newBlob === undefined ? undefined : headers.get(file.newBlob);
    return head !== undefined && headerHasMarker(head) && file.oldBlob !== undefined
      ? [file.oldBlob]
      : [];
  });
  if (bases.length > 0) keep(headers, await repo.readBlobs(bases));
  return headers;
}
