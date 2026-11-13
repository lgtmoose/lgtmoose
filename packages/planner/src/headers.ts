import type { FileDiff, Repo } from "@lgtmoose/git";
import { headerHasMarker, skipClassifier, type FileHeaders } from "./classify.js";

/** How much of each blob is kept: enough for the first few lines of a header. */
const HEADER_BYTES = 2048;

function keep(headers: Map<string, string>, blobs: Map<string, Buffer>): void {
  for (const [sha, content] of blobs) {
    headers.set(sha, content.subarray(0, HEADER_BYTES).toString("utf8"));
  }
}

/**
 * Reads the first lines of the files whose header can decide whether they're generated, for
 * `planReview`'s `headers` option. Only existing text files that the skip globs don't already
 * skip need it (a marker on a file the PR adds doesn't count). Head sides are read first, in one
 * batch (local after a full checkout); a base side is fetched only when its head has a marker.
 *
 * `configSkip` is the repo's `skip` globs, from the base commit, as given to `planReview`.
 */
export async function readHeaders(
  repo: Pick<Repo, "readBlobs" | "fullCheckout">,
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

  const heads = candidates.flatMap((file) => (file.newBlob === undefined ? [] : [file.newBlob]));
  keep(headers, await repo.readBlobs(heads, { local: repo.fullCheckout ? heads : [] }));

  const bases = candidates.flatMap((file) => {
    const head = file.newBlob === undefined ? undefined : headers.get(file.newBlob);
    return head !== undefined && headerHasMarker(head) && file.oldBlob !== undefined
      ? [file.oldBlob]
      : [];
  });
  if (bases.length > 0) keep(headers, await repo.readBlobs(bases));
  return headers;
}
