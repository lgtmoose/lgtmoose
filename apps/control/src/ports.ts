import type { Finding, ReviewEvent } from "@lgtmoose/core";
import type { CloneOptions, Repo } from "@lgtmoose/git";
import type { PullReader } from "@lgtmoose/pipeline";
import type { Poster, PullRef } from "@lgtmoose/poster";
import type { ReviewThread, ReviewThreadReader } from "./threads.js";

/** The artifact bucket, as the control task uses it. Keys are full object keys. */
export interface ArtifactStore {
  putText(key: string, body: string): Promise<void>;
  /**
   * Conditional writes, for the post step's claim and progress. Each returns the object's new
   * ETag, or undefined when the condition failed. A write racing another of the same key
   * throws. A failed condition on an object that holds exactly this body counts as success,
   * since it answers a retry of a write that was applied; so a body must be unique to its
   * writer (the claim names its attempt, and saved progress its attempt and write count).
   */
  /** Writes the object only if there's none yet. */
  createText(key: string, body: string): Promise<string | undefined>;
  /** Overwrites the object only if it's still the version with `etag`. */
  replaceText(key: string, body: string, etag: string): Promise<string | undefined>;
  /** The object's text and ETag, or undefined when there's no such object. */
  getTagged(key: string): Promise<{ text: string; etag: string } | undefined>;
  /** Deletes the object only if it's still the version with `etag`; else leaves it. */
  deleteIfMatch(key: string, etag: string): Promise<void>;
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
  /** The head the PR's last posted review was for. Undefined before its first. */
  lastReviewedSha: string | undefined;
  /** The status label the last posted review set. */
  statusLabel: string | undefined;
  /** The event of the last review posted on the PR. */
  lastReviewEvent: ReviewEvent | undefined;
  /** That review's GitHub ID; undefined in shadow mode. */
  lastReviewId: number | undefined;
  /** The head the run reviews. */
  headSha: string;
  /** The execution the run belongs to. */
  executionArn: string | undefined;
}

/** A file version a run reviewed. */
export interface FileRecord {
  path: string;
  blobSha: string;
  /** The base side's version (the merge base's), when there is one. */
  baseBlobSha: string | undefined;
  depth: "full" | "move" | "mechanical";
}

/** One of our findings recorded on a PR. */
export interface FindingRecord {
  id: string;
  fingerprint: string;
  ruleCategory: string;
  severity: "blocking" | "should_fix" | "nit";
  path: string;
  line: number;
  startLine: number | undefined;
  side: "LEFT" | "RIGHT";
  title: string;
  body: string;
  /** The head the finding was raised at: its line numbers are for that commit. */
  raisedAtSha: string;
  /** Outdated findings are followed too: one whose line comes back (a reverted fix) reopens. */
  status: "open" | "outdated";
  /** Its inline review comment on GitHub, when it was posted inline and the ID was read back. */
  githubCommentId: number | undefined;
  /**
   * The file's name on the base side of the PR's diff when it was raised: the file an old-side
   * line is in. Undefined for rows recorded before it was kept.
   */
  basePath: string | undefined;
}

/** A finding to record, with its inline comment's ID when it was posted inline. */
export interface FindingToSave {
  finding: Finding;
  fingerprint: string;
  githubCommentId?: number;
  /** Its file's base-side name in the PR's diff (see `FindingRecord.basePath`). */
  basePath?: string;
}

/** `findings` and `finding_events`, for our own findings. */
export interface FindingStore {
  /** Our findings on the PR that are open or outdated, oldest first. */
  trackedFindings(pullRequestId: string): Promise<FindingRecord[]>;
  /**
   * Our findings on the PR a person resolved or declined, at their recorded place: the person's
   * decision wins, so the reviewer raising one again is dropped.
   */
  closedFindings(pullRequestId: string): Promise<Omit<FindingRecord, "status">[]>;
  /**
   * Records a run's new findings as open, raised at `headSha`. A fingerprint already on the PR
   * (say, outdated, then raised again) is reopened at the new place; its severity is never
   * lowered, and it keeps its comment ID unless a new one is given.
   */
  saveFindings(
    pullRequestId: string,
    runId: string,
    headSha: string,
    findings: readonly FindingToSave[],
  ): Promise<void>;
  /**
   * Follows what people did to our comments' review threads: an open or outdated finding whose
   * thread is resolved becomes `resolved_by_human`, and one resolved that way whose thread was
   * unresolved again is open again. Each with an event by a person. Findings whose comment
   * isn't in `threads` (deleted, or never posted inline) are left as they are.
   */
  syncThreads(
    pullRequestId: string,
    threads: readonly ReviewThread[],
    sha: string,
  ): Promise<{ resolved: number; unresolved: number }>;
  /** Marks open findings outdated at `sha`: the lines they're on no longer exist. */
  markOutdated(ids: readonly string[], sha: string): Promise<void>;
  /** Reopens outdated findings at `sha`: the lines they're on exist again. */
  reopen(ids: readonly string[], sha: string): Promise<void>;
  /**
   * Raises open findings' severity at `sha`, with an `escalated` event: the reviewer raised them
   * again more severely. Only ever upwards; a finding no longer open is left as it is.
   */
  escalate(
    changes: readonly { id: string; severity: FindingRecord["severity"] }[],
    sha: string,
  ): Promise<void>;
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
    /** When the job's event happened, which orders the PR's runs. */
    eventAt?: Date;
  }): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** Records what the run reviews: how many files, and whether only since `fromSha`. */
  setPlan(
    runId: string,
    plan: {
      filesTotal: number;
      kind: "first" | "incremental" | "full";
      fromSha: string | undefined;
    },
  ): Promise<void>;
  /**
   * For each path, what the PR's latest posted (succeeded) run to cover it recorded: the version,
   * how closely it was read, and that run's head (`reviewedAt`), which the next incremental
   * review compares the file's PR change with. Only the latest counts: after a fix and a revert,
   * the reverted file's old blob was reviewed once, but its findings were marked outdated since.
   * Unposted runs' files are left out: their findings were never posted (see `unpostedRuns`).
   */
  reviewedFiles(pullRequestId: string): Promise<(FileRecord & { reviewedAt: string })[]>;
  /** Records file versions a posted run reviewed. Recording one twice is a no-op. */
  recordFiles(runId: string, files: readonly FileRecord[]): Promise<void>;
  /**
   * The PR's runs since its last posted one that didn't post (stopped, superseded or failed),
   * newest first, at most `limit`, leaving out `exceptRunId`. Their finished batches can be
   * picked up.
   */
  unpostedRuns(pullRequestId: string, exceptRunId: string, limit: number): Promise<string[]>;
  /**
   * Marks the run succeeded (it posted) and records what it set on the PR, unless a newer run
   * of the PR has already succeeded: the PR's record is the newest posted run's.
   */
  succeedRun(
    runId: string,
    result: {
      filesDone: number;
      costUsd: number | undefined;
      /**
       * The head to record as the PR's last reviewed commit, the start of the next incremental
       * review. Recorded even when a batch failed: its files have no record at this head, so
       * the next run reviews them (see `prepareReview`).
       */
      headSha: string;
      /** The label it set or set out to; undefined leaves the PR's recorded one alone. */
      statusLabel: string | undefined;
      summaryCommentId: number | undefined;
      /** The review this run posted: its event and ID. Undefined when it posted none. */
      review?: { event: ReviewEvent; id: number | undefined } | undefined;
    },
  ): Promise<void>;
  /** Marks the execution's run failed, if it got as far as having one. */
  failRun(executionArn: string, error: string): Promise<void>;
  /**
   * Whether a run of the same PR for a later event has written PR-level state: it succeeded,
   * or it was covered and wrote the PR's outputs (`coverRun` with `pr`). Its summary comment
   * and label are then the PR's, and an older run mustn't write over them.
   */
  newerRunPosted(run: RunRecord): Promise<boolean>;
  /**
   * Marks the run covered: it posted no review, since another run's review already covered its
   * head. Without `pr`, the PR's record is left to the run that posted.
   */
  coverRun(
    runId: string,
    result: {
      filesDone: number;
      costUsd: number | undefined;
      /**
       * The covering run's PR-level outputs this run wrote: recorded on the PR too, unless a
       * newer run has written PR-level state, and the run then counts as having written it.
       */
      pr?: {
        headSha: string;
        /** The label it set or set out to; undefined leaves the PR's recorded one alone. */
        statusLabel: string | undefined;
        summaryCommentId: number | undefined;
      };
    },
  ): Promise<void>;
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
  findings: FindingStore;
  tokens: TaskTokens;
  /**
   * GitHub for one installation: the PR reader, the clone token and the run's poster (in shadow
   * mode, one that records under the run's ID instead of posting).
   */
  github(installationId: number): Promise<{
    reader: PullReader;
    /** The PR's review threads, through GraphQL, to follow resolved ones. */
    threads: ReviewThreadReader;
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
