import { unlink } from "node:fs/promises";
import { walkTree } from "@lgtmoose/harness";

/**
 * Removes every symlink in the extracted checkout and returns their paths relative to it. A PR
 * can commit a symlink such as `docs/x -> /proc/self/environ`, or one into config a harness
 * leaves out. Every harness's read rules match the path the model asks for, not where it leads,
 * so a link could let a prompt-injected model read the task's environment, the model credential
 * included. Links that look harmless go too: the model gets the diff and file contents from the
 * prompt, so a review needs none, and telling safe links apart is where the holes were.
 */
export async function dropSymlinks(checkout: string): Promise<string[]> {
  const dropped: string[] = [];
  await walkTree(checkout, async ({ entry, path, rel }) => {
    if (!entry.isSymbolicLink()) return undefined;
    await unlink(path);
    dropped.push(rel);
    return undefined;
  });
  return dropped.sort();
}
