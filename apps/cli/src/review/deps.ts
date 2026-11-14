import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneAtSha, githubCloneUrl } from "@lgtmoose/git";
import { ClaudeCodeHarness } from "@lgtmoose/harness";
import { FileTranscriptStore, githubPullReader } from "@lgtmoose/pipeline";
import { githubRequest } from "../github-request.js";
import type { ReviewEnvironmentFactory } from "./review.js";
import { resolveGitHubToken } from "./token.js";

const GITHUB_API = "https://api.github.com";

/** The real I/O: GitHub over HTTPS, git, a temporary checkout and Claude Code on this machine. */
export const defaultReviewEnvironment: ReviewEnvironmentFactory = async (flags) => {
  const token = await resolveGitHubToken(process.env);
  if (token === undefined) {
    throw new Error(
      "No GitHub token. Set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`.",
    );
  }
  const transcriptDir =
    flags.transcripts ?? (await mkdtemp(join(tmpdir(), "lgtmoose-transcripts-")));
  return {
    transcriptDir,
    deps: {
      github: githubPullReader((path) =>
        githubRequest(fetch, GITHUB_API, "GET", path, { jwt: token }),
      ),
      clone: cloneAtSha,
      cloneUrl: (target) => githubCloneUrl(target.owner, target.repo),
      token,
      harness: new ClaudeCodeHarness({
        transcripts: new FileTranscriptStore(transcriptDir),
        ...(flags.claude === undefined ? {} : { binaryPath: flags.claude }),
      }),
      workDir: async () => {
        const dir = await mkdtemp(join(tmpdir(), "lgtmoose-review-"));
        return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
      },
      progress: (line) => process.stderr.write(`${line}\n`),
    },
  };
};
