import { mkdir } from "node:fs/promises";
import { GitError, runGit, type RunOptions } from "./exec.js";

/** A local checkout. Every command it runs carries the auth header, so lazily fetched blobs work. */
export interface Repo {
  readonly dir: string;
  readonly headSha: string;
  git(args: readonly string[], options?: Pick<RunOptions, "okExitCodes">): Promise<string>;
  /** Whether the commit is in this checkout (it may have been force-pushed away). */
  hasCommit(sha: string): Promise<boolean>;
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
   * Fetch commits and trees but download file contents only when a diff needs them, so a large
   * repo costs little more than the changed files. Default true.
   */
  partial?: boolean;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

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

/**
 * Checks out `headSha` with history (needed for merge bases) but, by default, without file
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
  const { config, secrets } = authConfig(options.token);
  const run = (args: readonly string[], extra: Pick<RunOptions, "okExitCodes"> = {}) =>
    runGit(options.dir, args, { config, secrets, ...extra });

  await mkdir(options.dir, { recursive: true });
  await run(["init", "--quiet"]);
  await run(["remote", "add", "origin", options.url]);
  const filter = options.partial === false ? [] : ["--filter=blob:none"];
  const fetch = (shas: readonly string[]) =>
    run(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", ...filter, "origin", ...shas]);

  await fetch([options.headSha]);
  // One at a time, so a commit that's gone doesn't stop the others.
  for (const sha of new Set(options.otherShas ?? [])) {
    if (sha === options.headSha) continue;
    try {
      await fetch([sha]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
    }
  }
  // Marks the fetched remote as the source of missing blobs for a partial clone.
  await run(["checkout", "--quiet", "--detach", options.headSha]);

  const repo: Repo = {
    dir: options.dir,
    headSha: options.headSha,
    git: async (args, extra) => (await run(args, extra)).stdout,
    hasCommit: async (sha) => {
      if (!SHA.test(sha)) return false;
      const { exitCode } = await run(["cat-file", "-e", `${sha}^{commit}`], {
        okExitCodes: [1, 128],
      });
      return exitCode === 0;
    },
  };
  return repo;
}
