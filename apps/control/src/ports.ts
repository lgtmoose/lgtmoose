import type { Budgets } from "@lgtmoose/config";
import type { Finding, ReviewEvent } from "@lgtmoose/core";
import type { CloneOptions, Repo } from "@lgtmoose/git";
import type { LearningsForBatch, PullReader, PullTarget } from "@lgtmoose/pipeline";
import type { Poster, PullRef } from "@lgtmoose/poster";
import type { TicketProvider } from "@lgtmoose/tickets";
import type { ReviewThread, ReviewThreadReader } from "./threads.js";
import type { Permission } from "./thread-policy.js";
import type { ReplyStore } from "./replies.js";
import type { BootstrapDeps } from "./bootstrap.js";
import type { SpendStore } from "./spend.js";

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
  /**
   * The review and label above came from a live run, so they're on GitHub (NIC-1141). Left out
   * when they came from a shadow run, or it isn't known: a live run doesn't go by them then.
   */
  reviewLive?: boolean;
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
  /**
   * Raised in shadow mode, never posted, and unanswered since (NIC-1141, `unpostedShadow`): a
   * live run retires it (`retireShadowFindings`). Left out when it isn't.
   */
  unpostedShadow?: boolean;
}

/** A finding to record, with its inline comment's ID when it was posted inline. */
export interface FindingToSave {
  finding: Finding;
  fingerprint: string;
  githubCommentId?: number;
  /** Its file's base-side name in the PR's diff (see `FindingRecord.basePath`). */
  basePath?: string;
  /** The learnings in its batch's prompt (NIC-1081). */
  learningIds?: readonly string[];
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
   * Retires the PR's findings raised in shadow mode, never posted and unanswered since
   * (NIC-1141, `unpostedShadow`): status `shadow`, with a `shadow_retired` event at `sha`.
   * Nobody could see them, so on a live run they don't count. Returns how many this call retired;
   * a second call retires none. Without it, nothing is retired.
   */
  retireShadowFindings?(pullRequestId: string, sha: string): Promise<number>;
  /**
   * The fingerprints of the PR's findings retired from shadow mode since its last full review
   * (`retiredSinceFullReview`), for the summary's note. Without it, no note.
   */
  retiredShadowFindings?(pullRequestId: string): Promise<string[]>;
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
  /**
   * Closes an open or outdated finding after the reply judge (`decideReply`): `fixed` and
   * `disputed` by us, `declined` by the reply's author. With an event naming the reply. False
   * when the finding wasn't open or outdated any more. Optional: without it, no reply is acted on.
   */
  closeForReply?(
    findingId: string,
    status: "fixed" | "declined" | "disputed",
    reply: { login: string; commentId: number },
    sha: string,
  ): Promise<boolean>;
  /**
   * Closes an open or outdated finding as fixed on the recheck's word (NIC-1120): our decision,
   * with no person's reply behind it. `closed` when this call closed it; `ours` when it was
   * closed already by our own `fixed` at `sha` (an earlier attempt of this run); `theirs` when
   * it was closed some other way (a person resolved or declined it, say).
   */
  closeFixed?(findingId: string, sha: string): Promise<"closed" | "ours" | "theirs">;
  /** Records that we replied on a finding's thread (`replied` or `dispute_answered`). */
  recordReply?(
    findingId: string,
    type: "replied" | "dispute_answered",
    commentId: number,
    sha: string,
  ): Promise<void>;
  /** The findings among `ids` with a `dispute_answered` event: never answered twice. */
  disputesAnswered?(ids: readonly string[]): Promise<Set<string>>;
  /**
   * Our inline comments on the PR's findings closed as fixed after a reply. They aren't a
   * reason to drop the reviewer raising the problem again, so they're left out of its context
   * and of the duplicate check against the PR's comments: a re-raise reopens the finding.
   */
  fixedCommentIds?(pullRequestId: string): Promise<number[]>;
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
  /**
   * Records whether the run's post is in shadow mode (NIC-1141), which decides whether its
   * findings were posted. Only the first call sets it: a retry after a deploy changed the mode
   * keeps the one its findings were saved in.
   */
  recordShadow?(runId: string, shadow: boolean): Promise<void>;
  /**
   * Succeeded automatic reviews of the pull request (`first` or `incremental`, not a full review
   * and not one a spend cap stopped) that started after `resume` or a review someone asked for.
   * The run that fulfills the request is not one of them. A failed run is not one of them.
   */
  automaticReviews(repo: string, number: number): Promise<number>;
  /** Starts that count over and forgets a review someone asked for that hadn't started. */
  resetAutomaticReviews(repo: string, number: number): Promise<void>;
  /**
   * A `review` or `full review` was asked for on `headSha`. The count starts over now. The run
   * that then reviews this head (this one, or the one CI releases) is not an automatic review.
   */
  armRequestedReview(repo: string, number: number, headSha: string): Promise<void>;
  /** The head from `armRequestedReview`, until that run starts or the pull request moves on. */
  requestedReviewHead(repo: string, number: number): Promise<string | undefined>;
  /** The pull request moved to another commit, so the asked-for review is no longer waiting. */
  forgetRequestedReview(repo: string, number: number): Promise<void>;
  /** `runId` is the review someone asked for, so it does not count as an automatic one. */
  noteRequestedRun(repo: string, number: number, runId: string): Promise<void>;
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
    /** The App's ID: its own comments aren't another reviewer's. Undefined in tests and CLI. */
    appId?: number;
    /** The App's slug, `@<slug>` in commands: what a waiting PR's check run tells people to type. */
    slug?: () => Promise<string>;
    /**
     * A login's permission on the PR's repository (the collaborators API): whether a resolved
     * thread on a blocking or protected finding counts (`resolutionHeld`). Without one, such a
     * resolution never counts.
     */
    permission?: (target: PullTarget, login: string) => Promise<Permission>;
    /** The PR's review threads, through GraphQL, to follow resolved ones. */
    threads: ReviewThreadReader;
    /**
     * Writes for the reply judge: a reply in a finding's review thread, and resolving that
     * thread. In shadow mode, logged instead. Without them, judgements aren't acted on.
     */
    conversation?: {
      reply(target: PullTarget, commentId: number, body: string): Promise<void>;
      /** A comment on the PR's conversation. */
      comment(target: PullTarget, body: string): Promise<void>;
      /** Resolves a review thread by its GraphQL node ID. */
      resolveThread(threadId: string): Promise<void>;
    };
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
  /** Replies waiting for the reply judge (`pending_replies`). Left out, none are judged. */
  replies?: ReplyStore;
  /**
   * Proposes a learning from a declined finding's reply, as its author's (through the learnings
   * policy, which reads their access from GitHub). Left out, none are proposed.
   */
  proposeLearning?: (
    installationId: number,
    proposal: { text: string; repo: string; prNumber: number; commentId: number; author: string },
  ) => Promise<void>;
  /**
   * Learning from outcomes (NIC-1081), after the post step settled judged replies: findings
   * people rejected (declined or disputed, with the reply that did it) may make a learning of a
   * repeated pattern, and record the learnings in their prompts as not followed; fixed ones
   * reinforce theirs. Left out, outcomes teach nothing. Failures are logged, never thrown.
   */
  outcomes?: {
    rejected(
      installationId: number,
      /** owner/name */
      repo: string,
      rejected: readonly { findingId: string; commentId?: number }[],
    ): Promise<void>;
    fixed(fixes: readonly { findingId: string; commentId?: number }[]): Promise<void>;
  };
  /**
   * The team's learnings for one batch of a PR in `org`'s `repo` (owner/name): retrieved here,
   * in the control task, never in the sandbox. Left out, prompts have none.
   */
  learnings?: (
    query: { org: string; repo: string } & Parameters<LearningsForBatch>[0],
  ) => ReturnType<LearningsForBatch>;
  /**
   * Ticket coverage (NIC-839): the ticket provider, which reads tickets here in the control task
   * with its own credential (the sandbox never gets it), the most tickets checked per PR, and
   * whether a public repository's summary may show ticket text (`tickets.detailsOnPublicRepos`).
   * Left out, tickets aren't read.
   */
  tickets?: {
    provider: TicketProvider;
    maxPerPullRequest: number;
    detailsOnPublicRepos?: boolean;
  };
  /**
   * Learning from a repository's review history (NIC-1080): the bootstraps, GitHub as a bootstrap
   * reads it, and the learnings it stores as pending. Left out, the deployment runs none.
   */
  bootstrap?: BootstrapDeps;
  /**
   * Spend caps (NIC-1079): the ledger and the deploy config's `budgets`. Left out (tests, the
   * CLI), nothing is capped or recorded.
   */
  spend?: { store: SpendStore; budgets: Budgets };
  /**
   * Which head a PR's review waits for CI on (`review.wait_for_checks`, NIC-1078), kept with the
   * dispatcher's records so a check finishing on that head asks for a run again. Left out
   * (tests, the CLI), no run waits for CI.
   */
  checksWaits?: ChecksWaitStore;
  /**
   * `commandAliases` (NIC-1119). A check run that says how to ask for a review names the App's
   * slug, or the first alias when the slug can't be read, or no handle at all.
   */
  commandAliases?: readonly string[];
  /**
   * Shadow mode: nothing is written to GitHub. A recheck's fixes are logged with the reply each
   * would have had (NIC-1125), since shadow findings have no thread to write it in.
   */
  shadow?: boolean;
}

/** A PR waiting for its CI: the head, since when, and what its check run last said. */
export interface ChecksWait {
  headSha: string;
  since: Date;
  state: string | undefined;
}

/** `pull_request_dispatches`' wait for CI. `repo` is passed as the job has it. */
export interface ChecksWaitStore {
  get(repo: string, number: number): Promise<ChecksWait | undefined>;
  /**
   * Records that the PR waits on `headSha`, with `state` as its check run's: since now, or
   * since the wait on that head began when it was already waiting on it. Returns the wait as it
   * was before (undefined when the PR wasn't waiting on this head).
   */
  wait(
    repo: string,
    number: number,
    headSha: string,
    state: string,
    now: Date,
  ): Promise<ChecksWait | undefined>;
  /** The PR no longer waits: its review started, or nothing is to be waited for. */
  clear(repo: string, number: number): Promise<void>;
  /**
   * Pull requests of `repo` waiting on `sha`. A commit status names the commit and not a pull
   * request, so the dispatcher asks here and runs each match. Empty when nothing waits.
   */
  byHead(repo: string, sha: string): Promise<readonly number[]>;
}
