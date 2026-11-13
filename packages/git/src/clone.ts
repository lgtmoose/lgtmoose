import { mkdir } from "node:fs/promises";
import { GitError, runGit, runGitBytes, type RunOptions } from "./exec.js";

/** A local checkout. Every command it runs carries the auth header, so lazily fetched blobs work. */
export interface Repo {
  readonly dir: string;
  readonly headSha: string;
  git(args: readonly string[], options?: Pick<RunOptions, "okExitCodes">): Promise<string>;
  /** Whether the commit is in this checkout (it may have been force-pushed away). */
  hasCommit(sha: string): Promise<boolean>;
  /**
   * Contents of many blobs, read by one `git cat-file --batch`. In a partial clone, missing ones
   * are first fetched together in one request rather than one request each.
   */
  readBlobs(shas: Iterable<string>): Promise<Map<string, Buffer>>;
  /** Writes these head paths into the working tree, for a clone made with `checkout: "none"`. */
  checkoutPaths(paths: readonly string[]): Promise<void>;
}

export interface CloneOptions {
  /** Repository URL, e.g. from `githubCloneUrl`. Must not contain credentials. */
  url: string;
  /** Empty or missing directory to check out into. */
  dir: string;
  /** The commit to review. */
  headSha: string;
  /**
   * Other commits the review needs: the base branch head and, for incremental reviews, the last
   * reviewed commit. A SHA the remote no longer has (force-pushed away and collected) is skipped;
   * the diff falls back to a full review for it.
   */
  otherShas?: readonly string[];
  /** GitHub App installation token. Sent as an HTTP header and never written to disk. */
  token?: string;
  /**
   * Fetch commits and trees but download file contents only when something reads them, so a
   * large repo costs little more than the changed files. Default true.
   */
  partial?: boolean;
  /**
   * "full" writes head's whole tree to disk, which in a partial clone downloads every file.
   * "none" writes nothing: diffs still work (they read from git), and `checkoutPaths` writes just
   * the files a step needs. Use "none" for large repositories. Default "full".
   */
  checkout?: "full" | "none";
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The remote doesn't have this object (force-pushed away and collected). Anything else, such as
 * an expired token, a network error or a rate limit, is a real failure and mustn't be mistaken
 * for a missing commit.
 */
export function isMissingObjectError(error: unknown): boolean {
  return (
    error instanceof GitError &&
    /not our ref|unadvertised object|couldn't find remote ref|no such remote ref/i.test(
      error.stderr,
    )
  );
}
/** Blob IDs per prefetch request, to keep the command line a sensible length. */
const PREFETCH_BATCH = 500;

export function githubCloneUrl(owner: string, repo: string, host = "github.com"): string {
  return `https://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
}

function authConfig(token: string | undefined): {
  config: Record<string, string>;
  secrets: string[];
} {
  if (!token) return { config: {}, secrets: [] };
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    config: { "http.extraHeader": `Authorization: Basic ${basic}` },
    secrets: [token, basic],
  };
}

/** Parses `git cat-file --batch` output: "<sha> <type> <size>\n<content>\n" per object. */
function parseBatch(output: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0x0a, offset);
    if (end === -1) break;
    const [sha = "", type, size] = output.subarray(offset, end).toString("utf8").split(" ");
    offset = end + 1;
    if (type === "missing" || size === undefined) continue;
    const length = Number(size);
    blobs.set(sha, output.subarray(offset, offset + length));
    offset += length + 1;
  }
  return blobs;
}

/**
 * Clones `headSha` with history (needed for merge bases) but, by default, without file
 * contents until something reads them. Fetches by SHA, so it works for fork PRs and commits that
 * no branch points at any more.
 */
export async function cloneAtSha(options: CloneOptions): Promise<Repo> {
  for (const sha of [options.headSha, ...(options.otherShas ?? [])]) {
    if (!SHA.test(sha)) throw new Error(`Not a full commit SHA: ${JSON.stringify(sha)}`);
  }
  if (/\/\/[^/]*@/.test(options.url)) {
    throw new Error("Pass the token separately; the clone URL must not contain credentials.");
  }
  if (options.url.startsWith("-")) throw new Error("The clone URL can't start with '-'.");
  const { config, secrets } = authConfig(options.token);
  const base: RunOptions = { config, secrets };
  const run = (args: readonly string[], extra: RunOptions = {}) =>
    runGit(options.dir, args, { ...base, ...extra });

  const partial = options.partial !== false;
  await mkdir(options.dir, { recursive: true });
  await run(["init", "--quiet"]);
  await run(["remote", "add", "origin", "--", options.url]);
  const filter = partial ? ["--filter=blob:none"] : [];
  const fetch = (shas: readonly string[], useFilter = true) =>
    run([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      ...(useFilter ? filter : []),
      "origin",
      ...shas,
    ]);

  const fetched = new Set([options.headSha]);
  await fetch([options.headSha]);
  // One at a time, so a commit that's gone doesn't stop the others.
  for (const sha of new Set(options.otherShas ?? [])) {
    if (fetched.has(sha)) continue;
    try {
      await fetch([sha]);
      fetched.add(sha);
    } catch (error) {
      if (!isMissingObjectError(error)) throw error;
    }
  }
  if (options.checkout === "none") {
    // HEAD and the index point at head without writing (or downloading) any file.
    await run(["update-ref", "--no-deref", "HEAD", options.headSha]);
    await run(["read-tree", options.headSha]);
  } else {
    await run(["checkout", "--quiet", "--detach", options.headSha]);
  }

  // Blobs known to be local, so a prefetch can leave them out: head's tree after a full
  // checkout, plus whatever this clone has already prefetched.
  const local = new Set<string>();
  if (partial && options.checkout !== "none") {
    const tree = await run(["ls-tree", "-r", "-z", "--full-tree", options.headSha]);
    for (const entry of tree.stdout.split("\0")) {
      const [mode, type, sha] = entry.split(/\s/);
      if (type === "blob" && mode !== "160000" && sha !== undefined) local.add(sha);
    }
  }

  /**
   * One request for every listed blob that isn't local yet, rather than git's lazy fetch, which
   * asks for each blob separately. If it fails, git falls back to fetching lazily.
   */
  const prefetch = async (shas: Iterable<string>): Promise<void> => {
    if (!partial) return;
    const missing = [...new Set(shas)].filter((sha) => SHA.test(sha) && !local.has(sha));
    for (let i = 0; i < missing.length; i += PREFETCH_BATCH) {
      const batch = missing.slice(i, i + PREFETCH_BATCH);
      try {
        // Without the blob filter, which would leave out the very blobs asked for.
        await fetch(batch, false);
        for (const sha of batch) local.add(sha);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
      }
    }
  };

  const readBlobs = async (shas: Iterable<string>): Promise<Map<string, Buffer>> => {
    const wanted = [...new Set(shas)].filter((sha) => SHA.test(sha));
    if (wanted.length === 0) return new Map();
    await prefetch(wanted);
    const { stdout } = await runGitBytes(options.dir, ["cat-file", "--batch"], {
      ...base,
      input: wanted.join("\n") + "\n",
    });
    return parseBatch(stdout);
  };

  return {
    dir: options.dir,
    headSha: options.headSha,
    git: async (args, extra) => (await run(args, extra)).stdout,
    hasCommit: async (sha) => {
      if (fetched.has(sha)) return true;
      if (!SHA.test(sha)) return false;
      // Present only if it's in head's history; a failed fetch already showed the remote lacks
      // it, so don't ask the remote again.
      const { exitCode } = await run(["cat-file", "-e", `${sha}^{commit}`], {
        okExitCodes: [1, 128],
        env: { GIT_NO_LAZY_FETCH: "1" },
      });
      return exitCode === 0;
    },
    readBlobs,
    checkoutPaths: async (paths) => {
      if (paths.length === 0) return;
      const literal = { env: { GIT_LITERAL_PATHSPECS: "1" } };
      // Find the files' blobs and fetch them in one request before checking out.
      const tree = await run(["ls-tree", "-z", options.headSha, "--", ...paths], literal);
      await prefetch(
        tree.stdout
          .split("\0")
          .map((entry) => entry.split(/\s/))
          .filter(([, type]) => type === "blob")
          .map(([, , sha]) => sha ?? ""),
      );
      // NUL-separated and literal, so no path is read as pathspec magic or split on a newline.
      await run(["checkout", options.headSha, "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: paths.join("\0") + "\0",
        ...literal,
      });
    },
  };
}
