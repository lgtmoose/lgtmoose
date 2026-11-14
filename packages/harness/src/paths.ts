import { isAbsolute, relative, sep } from "node:path";

/**
 * Whether `path` is `dir` itself or somewhere inside it. Both should be absolute and resolved
 * (realpath when links matter). A name that only starts with dots, like `..data`, is inside.
 */
export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}
