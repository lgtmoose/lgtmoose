import { readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

/** Whether `path` is `dir` or inside it. Both are real (resolved) paths. */
function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Removes every symlink in the extracted checkout that doesn't resolve to a path inside it,
 * dangling ones too, and returns their paths relative to the checkout. A PR can commit a symlink
 * such as `docs/x -> /proc/self/environ`. Every harness's read rules match the path the model
 * asks for, not where it leads, so the link would let a prompt-injected model read the task's
 * environment, the model credential included. Links that stay inside the checkout are kept.
 *
 * Each link is resolved with realpath (through any other links), so a chain that leaves the
 * checkout is caught however it's built. Directory links aren't followed while walking.
 */
export async function dropEscapingSymlinks(checkout: string): Promise<string[]> {
  const root = await realpath(checkout);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const dropped: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    const target = await realpath(path).catch(() => undefined);
    if (target !== undefined && inside(root, target)) continue;
    await unlink(path);
    dropped.push(relative(root, path));
  }
  return dropped.sort();
}
