import { opendir, realpath, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { isInside } from "@lgtmoose/harness";

/**
 * Removes every symlink in the extracted checkout that doesn't resolve to a path inside it,
 * dangling ones too, and returns their paths relative to the checkout. A PR can commit a symlink
 * such as `docs/x -> /proc/self/environ`. Every harness's read rules match the path the model
 * asks for, not where it leads, so the link would let a prompt-injected model read the task's
 * environment, the model credential included. Links that stay inside the checkout are kept.
 *
 * Each link is resolved with realpath (through any other links), so a chain that leaves the
 * checkout is caught however it's built. The walk reads one directory entry at a time and
 * doesn't follow directory links.
 */
export async function dropEscapingSymlinks(checkout: string): Promise<string[]> {
  const root = await realpath(checkout);
  const dropped: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of await opendir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => undefined);
        if (target !== undefined && isInside(root, target)) continue;
        await unlink(path);
        dropped.push(relative(root, path));
      }
    }
  };
  await walk(root);
  return dropped.sort();
}
