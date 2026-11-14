import { unlink } from "node:fs/promises";
import { isGone, walkTree } from "@lgtmoose/harness";

/**
 * Removes every symlink in the extracted checkout and returns their paths relative to it
 * (decoded, for the log). A PR can commit a symlink such as `docs/x -> /proc/self/environ`, or
 * one into config a harness leaves out. Every harness's read rules match the path the model asks
 * for, not where it leads, so a link could let a prompt-injected model read the task's
 * environment, the model credential included. Links that look harmless go too: the model gets
 * the diff and file contents from the prompt, so a review needs none, and telling safe links
 * apart is where the holes were.
 *
 * Paths are handled as raw bytes, so a name that isn't valid UTF-8 (which a PR can commit) is
 * removed or walked like any other, and an entry that's already gone is skipped.
 */
export async function dropSymlinks(checkout: string): Promise<string[]> {
  const dropped: string[] = [];
  await walkTree(checkout, async ({ entry, path, relText }) => {
    if (!entry.isSymbolicLink()) return undefined;
    try {
      await unlink(path);
    } catch (error) {
      if (!isGone(error)) throw error;
      return undefined;
    }
    dropped.push(relText);
    return undefined;
  });
  return dropped.sort();
}
