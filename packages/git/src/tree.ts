/** Paths per ls-tree, to stay well under the OS argument limit. */
const PATHS_PER_LIST = 1000;

/** One entry of `git ls-tree`. */
export interface TreeEntry {
  mode: string;
  /** blob, tree or commit (a submodule's gitlink). */
  type: string;
  sha: string;
  path: string;
}

/**
 * The tree entries for these paths at `sha`, with `recursive` expanding directories. Listed in
 * chunks, so a long list of paths never hits the OS argument limit, and literally, so no path
 * is read as a glob or pathspec magic. Paths `sha` doesn't have are left out.
 */
export async function listTree(
  git: (args: readonly string[]) => Promise<string>,
  sha: string,
  paths: readonly string[],
  { recursive = false }: { recursive?: boolean } = {},
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  for (let i = 0; i < paths.length; i += PATHS_PER_LIST) {
    const literal = paths.slice(i, i + PATHS_PER_LIST).map((path) => `:(literal)${path}`);
    const out = await git([
      "ls-tree",
      ...(recursive ? ["-r"] : []),
      "-z",
      "--full-tree",
      sha,
      "--",
      ...literal,
    ]);
    for (const line of out.split("\0")) {
      const match = /^(\d+) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(line);
      if (match === null) continue;
      const [, mode = "", type = "", entrySha = "", path = ""] = match;
      entries.push({ mode, type, sha: entrySha, path });
    }
  }
  return entries;
}
