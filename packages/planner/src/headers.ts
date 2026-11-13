import type { FileDiff, Repo } from "@lgtmoose/git";
import type { FileHeaders } from "./classify.js";

/** How much of each blob is kept: enough for the first few lines of a header. */
const HEADER_BYTES = 2048;

/**
 * Reads the first lines of both sides of each text file, in one batched read, for generated
 * detection (`planReview`'s `headers` option). Binary files, submodules and missing sides are
 * left out. After a full checkout head's blobs are local and aren't fetched again.
 */
export async function readHeaders(
  repo: Pick<Repo, "readBlobs" | "fullCheckout">,
  files: readonly FileDiff[],
): Promise<FileHeaders> {
  const text = files.filter((file) => !file.binary && !file.submodule);
  const heads = text.flatMap((file) => (file.newBlob === undefined ? [] : [file.newBlob]));
  const bases = text.flatMap((file) => (file.oldBlob === undefined ? [] : [file.oldBlob]));
  const blobs = await repo.readBlobs([...heads, ...bases], {
    local: repo.fullCheckout ? heads : [],
  });
  const headers = new Map<string, string>();
  for (const [sha, content] of blobs) {
    headers.set(sha, content.subarray(0, HEADER_BYTES).toString("utf8"));
  }
  return headers;
}
