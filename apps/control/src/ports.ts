import type { CloneOptions, Repo } from "@lgtmoose/git";
import type { PullReader } from "@lgtmoose/pipeline";
import type { Poster, PullRef } from "@lgtmoose/poster";

/** The artifact bucket, as the control task uses it. Keys are full object keys. */
export interface ArtifactStore {
  putText(key: string, body: string): Promise<void>;
  /** Uploads a local file, such as the checkout archive. */
  putFile(key: string, path: string, contentType: string): Promise<void>;
  /** The object's text, or undefined when there's no such object. */
  getText(key: string): Promise<string | undefined>;
}

/** One review run, as the post step needs it. */
export interface RunRecord {
  runId: string;
  pullRequestId: string;
  /** The summary comment to edit, from an earlier run of this PR. */
  summaryCommentId: number | undefined;
}

/** `review_runs` and `pull_requests` in the database. */
export interface RunStore {
  /** Records the PR and a running review run for it, with the workflow's execution ARN. */
  startRun(input: {
    installationId: number;
    repo: string;
    number: number;
    author: string;
    headSha: string;
    baseSha: string;
    executionArn: string;
  }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  setFilesTotal(runId: string, filesTotal: number): Promise<void>;
  /**
   * Marks the run succeeded (it posted) and records what it set on the PR, unless a newer run
   * of the PR has already succeeded: the PR's record is the newest posted run's.
   */
  succeedRun(
    runId: string,
    result: {
      filesDone: number;
      costUsd: number | undefined;
      headSha: string;
      statusLabel: string | undefined;
      summaryCommentId: number | undefined;
    },
  ): Promise<void>;
  /** Marks the execution's run failed, if it got as far as having one. */
  failRun(executionArn: string, error: string): Promise<void>;
  /**
   * Whether a run of the same PR created after this one has succeeded. Its summary comment and
   * label are then the PR's, and an older run mustn't write over them.
   */
  newerRunPosted(runId: string): Promise<boolean>;
  /** Marks a queued or running run superseded: a newer head or a close made it moot. */
  supersedeRun(runId: string): Promise<void>;
}

/** Step Functions task tokens, for the prepare step (`waitForTaskToken`). */
export interface TaskTokens {
  succeed(token: string, output: unknown): Promise<void>;
  fail(token: string, error: string, cause: string): Promise<void>;
}

/** Everything the control task's steps touch, per installation. Tests pass fakes. */
export interface ControlDeps {
  store: ArtifactStore;
  runs: RunStore;
  tokens: TaskTokens;
  /**
   * GitHub for one installation: the PR reader, the clone token and the run's poster (in shadow
   * mode, one that records under the run's ID instead of posting).
   */
  github(installationId: number): Promise<{
    reader: PullReader;
    token: () => Promise<string>;
    poster: (runId: string, pull: PullRef) => Poster;
  }>;
  clone(options: CloneOptions): Promise<Repo>;
  cloneUrl(owner: string, repo: string): string;
  /** A fresh, empty directory, and how to remove it. */
  workDir(): Promise<{ dir: string; remove(): Promise<void> }>;
  /** Writes a gzip tarball of `dir` (hidden files included) to `archive`. */
  archive(dir: string, archive: string): Promise<void>;
  log(message: string, fields?: Record<string, unknown>): void;
}
