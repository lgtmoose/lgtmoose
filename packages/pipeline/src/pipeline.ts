import { parseRepoConfigYaml, type RepoConfig } from "@lgtmoose/config";
import {
  bootstrapOutputSchema,
  citedCode,
  codeOccurrence,
  commentTitle,
  decide,
  dedupeFindings,
  explanationSchema,
  fingerprint,
  fingerprintParts,
  judgementSchema,
  reviewerOutputSchema,
  severityRank,
  MAX_TICKET_GAPS,
  coverageLevel,
  missingCore,
  ticketCoverageSchema,
  type BootstrapCandidate,
  type Explanation,
  type Finding,
  type HoldReason,
  type Judgement,
  type TicketCoverageResult,
  type FingerprintParts,
  type KnownFinding,
  type ReviewDecision,
  type Severity,
} from "@lgtmoose/core";
import type { CloneOptions, FileDiff, Repo } from "@lgtmoose/git";
import { reviewDiff } from "@lgtmoose/git";
import { HarnessError, type Harness, type HarnessUsage } from "@lgtmoose/harness";
import {
  planReview,
  readHeaders,
  readingDepth,
  type Batch,
  type Plan,
  type ReadingDepth,
} from "@lgtmoose/planner";
import {
  BOOTSTRAPPER_TIER,
  EXPLAINER_TIER,
  REPLY_JUDGE_TIER,
  TICKET_CHECKER_TIER,
  buildReviewerParts,
  clipBatchNotes,
  renderBatch,
  selectRulePacks,
  placeFindings,
  readConventionFilesAt,
  type PromptLearning,
  type PullRequestComment,
} from "@lgtmoose/roles";
import {
  GITHUB_COMMENT_LIMIT,
  SUMMARY_MARKER_ROOM,
  renderSummary,
  type TicketCoverage,
} from "@lgtmoose/summary";
import {
  describeKinds,
  detectInjection,
  type InjectionKind,
  type TextInjection,
} from "./injection.js";
import type { PullComment, PullReader, PullRequest, PullTarget } from "./pull.js";
import { reviewerMisses, type OtherReviewerFinding, type ReviewerMiss } from "./other-reviewers.js";

/** Everything a dry run touches outside its own process. Tests pass fakes. */
export interface ReviewDeps {
  github: PullReader;
  /** Clones the PR's repository (see `cloneAtSha` in @lgtmoose/git). */
  clone(options: CloneOptions): Promise<Repo>;
  /** The repository URL to clone, without credentials. */
  cloneUrl(target: PullTarget): string;
  token: string;
  harness: Harness;
  /** A fresh, empty directory for the checkout, and how to remove it. */
  workDir(): Promise<{ dir: string; remove(): Promise<void> }>;
  /** Progress for the person running it, on stderr. Never receives a secret or model output. */
  progress(line: string): void;
}

export interface ReviewOptions {
  target: PullTarget;
  /** Model name or alias for the reviewer, passed to the harness as is. */
  model: string;
  /** Deadline for each batch's run. */
  batchTimeoutMs: number;
  /** Groups this run's transcripts. */
  runId: string;
}

export interface BatchReport {
  index: number;
  files: string[];
  /** Skipped without a model call: every file in it was only moved. */
  skipped?: true;
  /** Skipped without a model call: an earlier run reviewed every file in it already. */
  done?: true;
  /** Why the batch failed. Undefined when it was reviewed. */
  error?: string;
  /**
   * What the reviewer noted for the cross-file pass (`BatchOutcome.notes`), with `files` the
   * input `collectBatchNotes` takes. Model output: leads, not facts.
   */
  notes?: string[];
  transcriptKeys: string[];
  usage?: HarnessUsage;
}

export interface DroppedReport {
  finding: Finding;
  /** `duplicate`: already raised on the PR or in this run. `misplaced`: not on a batch file. */
  reason: "duplicate" | "misplaced";
}

export interface ReviewReport {
  target: PullTarget;
  pr: Pick<PullRequest, "title" | "author" | "headSha" | "baseSha" | "baseRef" | "headRef">;
  /** Findings that would be posted as inline comments. */
  inline: Finding[];
  /** Findings that would go in the review body: outside the diff, or quoting the wrong line. */
  body: Finding[];
  dropped: DroppedReport[];
  /** Findings past the per-batch limit, least severe first. */
  overLimit: number;
  decision: ReviewDecision;
  /**
   * Whether every batch was reviewed and nothing the planner flagged (new code it skipped,
   * lockfile notes) is left for a person. False also holds approval.
   */
  complete: boolean;
  batches: BatchReport[];
  plan: { reviewed: number; skipped: number };
  /** The summary comment that would be posted. */
  summary: string;
  /** Whether the run reviewed only what changed since the last review. */
  kind: "full" | "incremental";
  /** This run's new findings (`inline` and `body`), each with its fingerprint, to record. */
  posted: { finding: Finding; fingerprint: string }[];
  /**
   * Earlier findings the reviewer raised again at a higher severity (a duplicate matched to
   * the finding itself): counted at that severity, and to store with it.
   */
  escalated: { fingerprint: string; severity: Severity }[];
  /**
   * Earlier open findings (by stored fingerprint) one of this run's findings was matched to:
   * the reviewer raised them again at this head. A finding someone says is fixed stays open
   * when it's here.
   */
  reraised: string[];
  /** Files a batch of this run reviewed (not done by blob, not failed). */
  reviewedNow: string[];
  /** File versions this run reviewed, to record so a later run can skip them. */
  reviewedFiles: ReviewedFile[];
  /** Other reviewers' open findings counted in the decision (`FinishOptions.others`). */
  others: number;
  /** Linked tickets' missing core requirements counted as should-fix (`FinishOptions.tickets`). */
  ticketGaps: number;
  /** Other reviewers' findings on files we reviewed that none of ours is near: for evals. */
  misses: ReviewerMiss[];
}

/** A file version a run reviewed, and how closely. */
export interface ReviewedFile {
  path: string;
  blobSha: string;
  /** The base side's version (the merge base's), when there is one. */
  baseBlobSha: string | undefined;
  depth: ReadingDepth;
}

/** A finding an earlier run posted that's still open, with its recorded fingerprint. */
export interface EarlierFinding {
  finding: Finding;
  fingerprint: string;
  /** Its inline review comment's GitHub ID, when it has one: that comment stands for it. */
  commentId?: number;
  /**
   * False when its place at this head isn't known: its line is gone, or it wasn't followed (a
   * closed finding on a file the PR no longer changes). Today's code at its recorded place says
   * nothing about it, so it's only matched by its stored fingerprint and comment ID. That's
   * also so for one whose commit is gone: it can't be followed exactly.
   */
  followed?: boolean;
}

/** A fingerprint and severity we have stored for one of our findings on the PR. */
export interface StoredSeverity {
  fingerprint: string;
  severity: Severity;
}

export interface FinishOptions {
  /**
   * Findings earlier runs posted that are still open. They count towards the decision and are
   * listed in the summary; a new finding with the same fingerprint isn't posted again.
   */
  earlier?: readonly EarlierFinding[];
  /**
   * Findings a person resolved or declined, followed to this head where their lines can be
   * (see `EarlierFinding.followed`). The person's decision wins: a re-raise matching one (its
   * fingerprint, stored or at its place now, or a duplicate of its comment) is dropped, and
   * doesn't count.
   */
  closed?: readonly EarlierFinding[];
  /**
   * The severity each of our recorded findings is stored at. A new finding with one's
   * fingerprint (an outdated one raised again) is counted at the more severe of the two, as
   * it's stored.
   */
  stored?: readonly StoredSeverity[];
  /**
   * Other reviewers' open findings (`otherReviewerFindings`): they count towards the decision
   * and are listed in the summary, but aren't posted or recorded as ours. Our duplicates of
   * them are already dropped, since their comments are among the PR's.
   */
  others?: readonly OtherReviewerFinding[];
  /**
   * Our blocking or protected findings whose review thread is resolved, but not by someone it
   * counts for (the PR's author, or someone without write access): they stay open, and the
   * summary says why.
   */
  heldResolutions?: number;
  /**
   * Our GitHub App's ID: the prompt-injection detector leaves our own comments out, since they
   * can quote what it flagged.
   */
  ourAppId?: number;
  /** Ticket coverage (NIC-839), when a ticket provider is configured. */
  tickets?: TicketReview;
}

/**
 * The tickets a PR names and how the ticket checker found the PR covers them (NIC-839), for the
 * summary and the decision. The checker's checklists are model output: only their missing core
 * requirements count, as should-fix findings, at most `MAX_TICKET_GAPS` per review.
 */
export interface TicketReview {
  /** The provider's name, such as Linear. */
  provider: string;
  tickets: {
    key: string;
    title: string;
    url?: string;
    /** The checker's checklist. Undefined when the check failed or didn't run (`note` says). */
    coverage?: TicketCoverageResult;
    /** Why there's no checklist, in plain code text. */
    note?: string;
  }[];
  /**
   * Tickets whose text the prompt-injection detector flagged (`scanText`): they hold approval,
   * like a flagged PR description.
   */
  injected: { key: string; kinds: InjectionKind[] }[];
  /**
   * Whether the summary may show ticket text: titles, links, the checker's notes and the missing
   * requirements (which paraphrase the ticket). False on a public repository unless the operator
   * opts in (`tickets.detailsOnPublicRepos`): then only each key, its coverage level and how
   * many core requirements look missing are shown, since the comment is public and the tickets
   * may not be.
   */
  details: boolean;
  /**
   * Why no tickets were read, in plain code text, such as "ticket coverage runs only for pull
   * requests by the repository's owners, members and collaborators". It names no keys.
   */
  notice?: string;
}

/** A ticket key as providers give them; anything else isn't shown in the decision's reasons. */
const TICKET_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

/**
 * The ticket review's should-fix gaps (missing core requirements, at most `MAX_TICKET_GAPS`)
 * and its table for the summary.
 */
function ticketParts(tickets: TicketReview | undefined): {
  gaps: number;
  table: TicketCoverage | undefined;
} {
  if (tickets === undefined) return { gaps: 0, table: undefined };
  const missing = tickets.tickets.flatMap((ticket) =>
    ticket.coverage === undefined ? [] : missingCore(ticket.coverage),
  );
  const gaps = Math.min(missing.length, MAX_TICKET_GAPS);
  const { details } = tickets;
  // Ours when there's no checklist; otherwise the checker's summary, if any, and only with
  // details: it paraphrases the ticket. Without details, just how many look missing.
  const noteOf = (ticket: TicketReview["tickets"][number]): { note?: string } => {
    if (ticket.note !== undefined) return { note: ticket.note };
    if (details)
      return ticket.coverage?.summary === undefined ? {} : { note: ticket.coverage.summary };
    const count = ticket.coverage === undefined ? 0 : missingCore(ticket.coverage).length;
    return count === 0
      ? {}
      : {
          note: `${count} core requirement${count === 1 ? "" : "s"} look${count === 1 ? "s" : ""} missing`,
        };
  };
  return {
    gaps,
    table: {
      provider: tickets.provider,
      ...(tickets.notice === undefined ? {} : { notice: tickets.notice }),
      tickets: tickets.tickets.map((ticket) => ({
        key: ticket.key,
        // A public repository's summary names the key only: no title, link or requirement text.
        title: details ? ticket.title : "",
        ...(details && ticket.url !== undefined ? { url: ticket.url } : {}),
        coverage: ticket.coverage === undefined ? "not_checked" : coverageLevel(ticket.coverage),
        ...noteOf(ticket),
        ...(details && ticket.coverage !== undefined
          ? { missing: missingCore(ticket.coverage).map((req) => req.text) }
          : {}),
      })),
      footnote:
        `Coverage is a model's reading of the diff against each ticket, so check it. ` +
        `Each missing core requirement counts as a should-fix finding, up to ${MAX_TICKET_GAPS} per review` +
        (missing.length > MAX_TICKET_GAPS ? ` (${missing.length} found)` : "") +
        "; it never blocks the merge on its own." +
        (details
          ? ""
          : " This repository is public, so tickets' titles and requirements aren't shown."),
    },
  };
}

/**
 * Everything the review knows once the PR is cloned and planned, before any model runs. It's
 * plain JSON, so the workflow can write it to S3 in the prepare step and read it back in the
 * post step (NIC-811); the dry run keeps it in memory.
 */
export interface PreparedReview {
  target: PullTarget;
  pr: PullRequest;
  comments: PullComment[];
  config: RepoConfig;
  /** The PR's merge base, from `reviewDiff`. */
  mergeBase: string;
  files: FileDiff[];
  plan: Plan;
  conventionFilesOmitted: string[];
  /** Rule-pack entries or rules left out, and why (see `selectRulePacks`). */
  rulePackProblems?: string[];
  /** One entry per planned batch, in order. */
  jobs: BatchJob[];
  /**
   * The part of every batch's prompt that they all share (the role and the built-in and
   * private rule packs, see `buildReviewerParts`), sent as the harness's `system` so it's
   * prompt-cached. Each job's `prompt` is the rest. Undefined in runs prepared before it was
   * split out, whose prompts are whole.
   */
  reviewerSystem?: string;
  /**
   * `incremental`: only the files whose PR change moved since each was last reviewed (see
   * `reviewDiff`). `full`: the whole PR, also when no file has a usable earlier review.
   */
  kind: "full" | "incremental";
  /** Why an incremental review became a full one: the last reviewed commit is gone. */
  fallbackReason?: string;
  /**
   * Planned files that need no model run: an earlier run reviewed the same blob at least as
   * closely (see `PrepareOptions.reviewed` and `resumed`), with the depth it read them at.
   * Their batches leave them out of the prompt.
   */
  done: { path: string; depth: ReadingDepth }[];
  /**
   * Findings earlier, unposted runs found on `done` files, posted with this run's: one entry per
   * resumed batch, with the files of it that are done here, so each is placed on its own files
   * and keeps its own per-batch limit.
   */
  carried: CarriedBatch[];
  /**
   * Files covered at this head without a review: their PR change hasn't moved since they were
   * last reviewed (see `ReviewDiff.unchanged`). Recorded at this head with the depth they were
   * read at, so later runs compare with this head.
   */
  unchanged: ReviewedFile[];
  /**
   * Files the PR no longer changes at all though it did at an earlier review, with the lines it
   * added then and no longer does: reported in the summary, nothing to review in them.
   */
  noLongerChanged: { path: string; lines: string[] }[];
}

/**
 * One batch to review: its prompt, `skipped` when every file in it was only moved, or `done`
 * when an earlier run already reviewed every file in it at the same blob.
 */
export interface BatchJob {
  index: number;
  files: string[];
  /** The reviewer prompt, for the batch's files that aren't done. Undefined otherwise. */
  prompt?: string;
  skipped?: true;
  done?: true;
}

/** A resumed batch's findings, and the files of it that are done here. */
export interface CarriedBatch {
  files: string[];
  findings: Finding[];
}

/** A file version an earlier run reviewed, and how closely. */
export interface ReviewedBlob {
  path: string;
  blobSha: string;
  /** The base side's version it was read against; both sides must match to count as read. */
  baseBlobSha: string | undefined;
  depth: ReadingDepth;
  /** The head of the run that recorded it: where the file's PR change was last reviewed. */
  reviewedAt: string;
}

/**
 * One batch a run finished but never posted (it was stopped, superseded or failed later on):
 * the files it covered, at the blobs and depth it saw them, and what it found on them.
 */
export interface ResumedWork {
  files: {
    path: string;
    oldBlob: string | undefined;
    newBlob: string | undefined;
    depth: ReadingDepth;
  }[];
  findings: Finding[];
}

export interface PrepareOptions {
  /**
   * Each path's latest version a posted run reviewed (see `reviewedBlobOf`). A planned file at
   * that version is done, if it was read at least as closely as this plan reads it; on an
   * incremental review, a PR file outside the range that isn't covered is planned too.
   */
  reviewed?: readonly ReviewedBlob[];
  /** Unposted runs' finished batches: their files are done and their findings carried over. */
  resumed?: readonly ResumedWork[];
  /**
   * Review threads (by their first comment's ID) left out of the reviewer's context: our
   * findings someone says are fixed. Without our comment, the reviewer isn't told not to raise
   * them again, so it checks the code at head on its own (see `ReviewReport.reraised`). They
   * still count for duplicate checks.
   */
  hiddenThreads?: ReadonlySet<number>;
}

/** What one batch's reviewer run returned. Findings are placed and checked in `finishReview`. */
export interface BatchOutcome {
  index: number;
  /** The model's findings, validated with `reviewerOutputSchema`. Undefined when it failed. */
  findings?: Finding[];
  /**
   * The reviewer's notes for the cross-file pass, within the soft limits (`clipBatchNotes`).
   * Model output: untrusted, like the findings.
   */
  notes?: string[];
  /** Why the batch failed. */
  error?: string;
  transcriptKeys: string[];
  usage?: HarnessUsage;
}

/** How many comments of each kind are read for context and duplicate checks. */
const COMMENT_LIMIT = 200;
/** Longest comment body passed to the model as context. */
const COMMENT_BODY_LIMIT = 4000;

/** Why a run held approval; `incomplete` is spelled out from the batches and the plan instead. */
const HOLD_TEXT: Record<Exclude<HoldReason, "incomplete">, string> = {
  prompt_injection: "a prompt-injection attempt was flagged",
  approve_disabled: "approvals are turned off (gate.approve: false)",
};

/** Why a hit outside the diff held approval, for the summary. Logins are shown only if valid. */
function injectionReason(hit: TextInjection): string {
  let where = "the PR's description";
  if (hit.source === "title") where = "the PR's title";
  if (hit.source === "comment") {
    const login = hit.author ?? "";
    // The summary escapes it besides.
    where = `a comment by ${/^[A-Za-z0-9-]+(\[bot\])?$/.test(login) ? login : "an unknown author"}`;
  }
  return `${HOLD_TEXT.prompt_injection} in ${where}: ${describeKinds(hit.kinds)}`;
}

/** The summary's lines for a hold: one per flagged text for a prompt-injection hold. */
function holdReasons(hold: HoldReason, injected: readonly TextInjection[]): string[] {
  if (hold === "incomplete") return [];
  if (hold === "prompt_injection") return injected.map(injectionReason);
  return [HOLD_TEXT[hold]];
}

/** The blob ID of a path at a commit, when it's a regular file. */
async function blobAt(repo: Repo, sha: string, path: string): Promise<string | undefined> {
  const entry = await repo.git(["ls-tree", "-z", sha, "--", path]);
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t/.exec(entry);
  return match?.[2];
}

/**
 * The repo config from the base commit, not the PR's head: a PR could otherwise change what is
 * skipped or how it's judged. Defaults when the base has no `.lgtmoose.yaml`.
 */
async function baseConfig(repo: Repo, baseSha: string): Promise<RepoConfig> {
  const blob = await blobAt(repo, baseSha, ".lgtmoose.yaml");
  if (blob === undefined) return parseRepoConfigYaml(undefined);
  const content = (await repo.readBlobs([blob])).get(blob);
  return parseRepoConfigYaml(content?.toString("utf8"));
}

/** Reads file contents from git blobs (never the working tree, where a path can be a symlink). */
function lineReader(repo: Repo): (blob: string | undefined) => Promise<string[]> {
  const cache = new Map<string, Promise<string[]>>();
  return (blob) => {
    if (blob === undefined) return Promise.resolve([]);
    let lines = cache.get(blob);
    if (lines === undefined) {
      lines = repo
        .readBlobs([blob])
        .then((blobs) => (blobs.get(blob)?.toString("utf8") ?? "").split("\n"));
      cache.set(blob, lines);
    }
    return lines;
  };
}

function contextComments(comments: readonly PullComment[]): PullRequestComment[] {
  return comments.map((comment) => ({
    author: comment.author,
    body: comment.body.slice(0, COMMENT_BODY_LIMIT),
    ...(comment.path === undefined ? {} : { path: comment.path }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
  }));
}

/**
 * Fingerprints for the comments already on the PR's diff, from anyone, so a finding someone
 * already raised isn't raised again. Comments on lines no longer in the diff are left out:
 * their code may have changed.
 */
async function knownFindings(
  comments: readonly PullComment[],
  files: ReadonlyMap<string, FileDiff>,
  readLines: (blob: string | undefined) => Promise<string[]>,
  ours: readonly EarlierFinding[],
): Promise<KnownFinding[]> {
  const known: KnownFinding[] = [];
  for (const comment of comments) {
    if (comment.path === undefined || comment.line === undefined) continue;
    const file = files.get(comment.path);
    if (file === undefined) continue;
    const lines = await readLines(comment.side === "LEFT" ? file.oldBlob : file.newBlob);
    const start = comment.startLine ?? comment.line;
    const parts = fingerprintParts({
      path: comment.path,
      title: commentTitle(comment.body),
      code: citedCode(lines, comment.line, start),
      occurrence: codeOccurrence(lines, comment.line, start),
    });
    // Our comment on an earlier finding (by its GitHub ID) stands for it.
    const own =
      comment.id === undefined ? undefined : ours.find((entry) => entry.commentId === comment.id);
    known.push({ fingerprint: own?.fingerprint ?? fingerprint(parts), parts });
  }
  return known;
}

/**
 * Our recorded findings as known findings for the duplicate check. Each is known under its
 * stored fingerprint, and, when its line was followed to this head, under the one at its place
 * now (a rename changes it), with its code there for fuzzy matches; protected categories only
 * ever match exactly. One that couldn't be followed is known by its stored fingerprint only:
 * the code at its recorded place may be something else now. `storedOf` gets each current
 * fingerprint that differs from the stored one, mapped to the stored one.
 */
async function recordedKnown(
  entries: readonly EarlierFinding[],
  partsOf: (finding: Finding) => Promise<FingerprintParts>,
  storedOf: Map<string, string>,
): Promise<KnownFinding[]> {
  const known = await Promise.all(
    entries.map(async (entry): Promise<KnownFinding[]> => {
      if (entry.followed === false) return [{ fingerprint: entry.fingerprint }];
      const parts = await partsOf(entry.finding);
      const here = fingerprint(parts);
      if (here === entry.fingerprint) return [{ fingerprint: here, parts }];
      storedOf.set(here, entry.fingerprint);
      return [
        { fingerprint: entry.fingerprint, parts },
        { fingerprint: here, parts },
      ];
    }),
  );
  return known.flat();
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function errorText(error: unknown): string {
  if (error instanceof HarnessError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The team's learnings for one batch: its files and its rendered diff, to rank against (see
 * `retrieveLearnings` in @lgtmoose/learnings, which the caller binds to the PR's org and repo).
 */
export type LearningsForBatch = (batch: {
  paths: readonly string[];
  diff: string;
}) => Promise<readonly PromptLearning[]>;

export interface PrepareDeps {
  github: PullReader;
  progress(line: string): void;
  /**
   * The learnings each batch's prompt gets. Left out, prompts have none. A retrieval that fails
   * is logged and the batch goes without: a review never fails for its learnings.
   */
  learnings?: LearningsForBatch;
}

/**
 * Reads the PR's comments, config and conventions, plans it and builds each batch's prompt.
 * `repo` is the PR's head, cloned with the base SHA (see `runReview`); it isn't cloned here.
 */
export async function prepareReview(
  deps: PrepareDeps,
  target: PullTarget,
  repo: Repo,
  pr: PullRequest,
  options: PrepareOptions = {},
): Promise<PreparedReview> {
  const comments = await deps.github.comments(target, COMMENT_LIMIT);
  const config = await baseConfig(repo, pr.baseSha);
  // With records, each file is compared with its own last review: a file whose batch failed
  // keeps the commit it was last reviewed at, so what changed since then is still reviewed.
  const reviewed = new Map((options.reviewed ?? []).map((entry) => [entry.path, entry]));
  const diff = await reviewDiff(repo, {
    baseSha: pr.baseSha,
    reviewedAt: new Map([...reviewed].map(([path, entry]) => [path, entry.reviewedAt])),
  });
  if (diff.fallbackReason !== undefined) deps.progress(diff.fallbackReason);
  const { files } = diff;
  const prFiles = new Map(diff.prFiles.map((file) => [file.path, file]));
  const unchanged = diff.unchanged.map((path) => {
    const file = prFiles.get(path);
    return {
      path,
      // The PR doesn't change the path at all now.
      blobSha: (file === undefined ? undefined : reviewedBlobOf(file)) ?? NOT_CHANGED,
      baseBlobSha: file?.oldBlob,
      // Every covered path has a record; without one, the lowest depth claims the least.
      depth: reviewed.get(path)?.depth ?? ("move" as const),
    };
  });
  const headers = await readHeaders(repo, files, { skip: config.skip, include: config.include });
  const plan = planReview(files, config, { headers });
  const conventions = await readConventionFilesAt(repo, pr.baseSha, {
    globs: config.conventions,
  });
  const selected = await selectRulePacks(config.rulepacks, { repo, baseSha: pr.baseSha });
  for (const note of [...selected.warnings, ...selected.problems]) {
    deps.progress(`Rule packs: ${note}`);
  }
  const rulePacks = selected.packs;
  // A file whose earlier review can't be compared with (its commit is gone) is reviewed afresh,
  // as on a first review: an earlier record of its blob doesn't make it done. Duplicates of what
  // that review posted are dropped against our comments on the PR.
  const gone = new Set(diff.baselineGone ?? []);
  const { done, carried } = doneFiles(plan, {
    ...options,
    reviewed: (options.reviewed ?? []).filter((entry) => !gone.has(entry.path)),
  });
  deps.progress(
    `${count(plan.files.length, "file")} to review in ${count(plan.batches.length, "batch", "batches")}, ${plan.skipped.length} skipped${done.size > 0 ? `, ${done.size} already reviewed` : ""}.`,
  );

  const context = {
    pr: {
      title: pr.title,
      body: pr.body,
      author: pr.author,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
    },
    comments: contextComments(
      comments.filter((comment) => {
        const hidden = options.hiddenThreads;
        if (hidden === undefined) return true;
        const root = comment.inReplyTo ?? comment.id;
        return root === undefined || !hidden.has(root);
      }),
    ),
    conventions: conventions.files,
    rulePacks,
  };
  // The same for every batch: it doesn't depend on the batch's files.
  let reviewerSystem: string | undefined;
  const jobs: BatchJob[] = [];
  // One batch at a time: retrieval may call an embeddings provider.
  for (const batch of plan.batches) {
    const paths = batch.files.map((planned) => planned.file.path);
    if (batch.files.every((planned) => planned.depth === "move")) {
      jobs.push({ index: batch.index, files: paths, skipped: true });
      continue;
    }
    const todo = batch.files.filter((planned) => !done.has(planned.file.path));
    if (todo.every((planned) => planned.depth === "move")) {
      jobs.push({ index: batch.index, files: paths, done: true });
      continue;
    }
    const reviewBatch = { ...batch, files: todo };
    const learnings = await batchLearnings(deps, reviewBatch);
    const { system, prompt } = buildReviewerParts({
      ...context,
      ...(learnings.length === 0 ? {} : { learnings }),
      batch: reviewBatch,
    });
    reviewerSystem = system;
    jobs.push({ index: batch.index, files: paths, prompt });
  }
  return {
    target,
    pr,
    comments,
    config,
    mergeBase: diff.mergeBase,
    files,
    plan,
    conventionFilesOmitted: conventions.omitted,
    rulePackProblems: selected.problems,
    jobs,
    ...(reviewerSystem === undefined ? {} : { reviewerSystem }),
    kind: diff.kind,
    ...(diff.fallbackReason === undefined ? {} : { fallbackReason: diff.fallbackReason }),
    done: [...done].map(([path, depth]) => ({ path, depth })),
    carried,
    unchanged,
    noLongerChanged: diff.noLongerChanged,
  };
}

/** A batch's learnings from `deps.learnings`; none when there's no retriever or it fails. */
async function batchLearnings(
  deps: PrepareDeps,
  batch: Parameters<typeof renderBatch>[0],
): Promise<readonly PromptLearning[]> {
  if (deps.learnings === undefined) return [];
  try {
    return await deps.learnings({
      paths: batch.files.map((planned) => planned.file.path),
      diff: renderBatch(batch),
    });
  } catch (error) {
    deps.progress(
      `Learnings left out of a batch: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/** What `files_reviewed` records for a path the PR doesn't change at a head it was covered at. */
export const NOT_CHANGED = "not-changed";

/**
 * What the planner flagged for a person: new code it skipped, and lockfile changes it couldn't
 * review. No findings there doesn't mean nothing is wrong, so they hold approval. Skipped files
 * are never recorded as reviewed, so an incremental plan has every one the PR still changes.
 */
export function unreviewedReasons(skipped: Plan["skipped"]): string[] {
  return [
    ...(skipped.some((entry) => entry.newCode === true)
      ? ["new code in vendored, build or generated paths wasn't reviewed"]
      : []),
    ...(skipped.some((entry) => (entry.notes?.length ?? 0) > 0)
      ? ["dependency changes in lockfiles need a person to check them"]
      : []),
  ];
}

/**
 * The version of a file a review reads, as `files_reviewed` records it: the blob at head, or
 * for a deleted file, the version it deletes (marked, so it never matches a file at head).
 * Undefined when there's neither.
 */
export function reviewedBlobOf(file: {
  oldBlob: string | undefined;
  newBlob: string | undefined;
}): string | undefined {
  if (file.newBlob !== undefined) return file.newBlob;
  return file.oldBlob === undefined ? undefined : `deleted:${file.oldBlob}`;
}

/** How closely a depth reads a file: a file read this closely is read at any lower depth too. */
const DEPTH_RANK: Record<ReadingDepth, number> = { move: 0, mechanical: 1, full: 2 };

/**
 * Whether an earlier read of a file covers reading it now: the same versions on both sides of
 * the diff (head and merge base), read as closely.
 */
function covers(
  earlier: { blobSha: string; baseBlobSha: string | undefined; depth: ReadingDepth } | undefined,
  file: FileDiff,
  depth: ReadingDepth = readingDepth(file),
): boolean {
  const blob = reviewedBlobOf(file);
  return (
    earlier !== undefined &&
    blob !== undefined &&
    earlier.blobSha === blob &&
    earlier.baseBlobSha === file.oldBlob &&
    DEPTH_RANK[earlier.depth] >= DEPTH_RANK[depth]
  );
}

/**
 * Planned files an earlier run reviewed at the same version, at least as closely as this plan
 * would, with the depth they were read at, and the findings unposted runs made on them. A
 * finding on the old side is carried only when the old blob matches too. Files with lines
 * removed since the last review are always reviewed: the removal is what's left to look at.
 */
function doneFiles(
  plan: Plan,
  options: PrepareOptions,
): { done: Map<string, ReadingDepth>; carried: CarriedBatch[] } {
  const reviewed = new Map((options.reviewed ?? []).map((entry) => [entry.path, entry]));
  const candidates = plan.files.filter(
    ({ file }) => (file.removedSinceLastReview?.length ?? 0) === 0,
  );
  const done = new Map<string, ReadingDepth>();
  const mark = (path: string, depth: ReadingDepth) => {
    const known = done.get(path);
    if (known === undefined || DEPTH_RANK[depth] > DEPTH_RANK[known]) done.set(path, depth);
  };
  const carried: CarriedBatch[] = [];
  for (const { file, depth } of candidates) {
    const earlier = reviewed.get(file.path);
    if (earlier !== undefined && covers(earlier, file, depth)) mark(file.path, earlier.depth);
  }
  for (const work of options.resumed ?? []) {
    const seen = new Map(work.files.map((entry) => [entry.path, entry]));
    const same = new Map<string, { oldSide: boolean }>();
    for (const { file, depth } of candidates) {
      const entry = seen.get(file.path);
      const blobSha = entry === undefined ? undefined : reviewedBlobOf(entry);
      if (entry === undefined || blobSha === undefined) continue;
      if (!covers({ blobSha, baseBlobSha: entry.oldBlob, depth: entry.depth }, file, depth)) {
        continue;
      }
      mark(file.path, entry.depth);
      same.set(file.path, { oldSide: entry.oldBlob === file.oldBlob });
    }
    const findings = work.findings.filter((finding) => {
      const match = same.get(finding.path);
      return match !== undefined && (finding.side === "RIGHT" || match.oldSide);
    });
    if (findings.length > 0) carried.push({ files: [...same.keys()], findings });
  }
  return { done, carried };
}

export interface RunBatchOptions {
  /** The checkout the model may read. */
  cwd: string;
  model: string;
  timeoutMs: number;
  /** Groups this batch's transcripts, such as `<run id>-batch-<index>`. */
  runId: string;
  /** The prompt part every batch shares (`PreparedReview.reviewerSystem`). */
  system?: string;
}

/** Runs the reviewer on one batch. A failed run is an outcome with `error`, never a throw. */
export async function runBatch(
  harness: Harness,
  job: BatchJob,
  options: RunBatchOptions,
): Promise<BatchOutcome> {
  if (job.prompt === undefined) return { index: job.index, findings: [], transcriptKeys: [] };
  try {
    const result = await harness.run({
      prompt: job.prompt,
      ...(options.system === undefined ? {} : { system: options.system }),
      cwd: options.cwd,
      schema: reviewerOutputSchema,
      model: options.model,
      timeoutMs: options.timeoutMs,
      runId: options.runId,
    });
    const notes = clipBatchNotes(result.output.notes ?? []);
    return {
      index: job.index,
      findings: result.output.findings,
      ...(notes.length === 0 ? {} : { notes }),
      transcriptKeys: result.transcriptKeys ?? [result.transcriptKey],
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  } catch (error) {
    const keys = error instanceof HarnessError ? [...error.transcriptKeys] : [];
    return { index: job.index, error: errorText(error), transcriptKeys: keys };
  }
}

/** What the reply judge's run on one batch came to: a judgement, or why it failed. */
export interface JudgeOutcome {
  index: number;
  judgement?: Judgement;
  error?: string;
  transcriptKeys: string[];
  usage?: HarnessUsage;
}

/**
 * Runs the reply judge on one reply (its prompt from `buildReplyJudgePrompt`), on the fast tier.
 * A failed run is an outcome with `error`, never a throw.
 */
export async function runJudge(
  harness: Harness,
  job: { index: number; prompt: string },
  options: Omit<RunBatchOptions, "system">,
): Promise<JudgeOutcome> {
  try {
    const result = await harness.run({
      prompt: job.prompt,
      cwd: options.cwd,
      schema: judgementSchema,
      model: options.model,
      timeoutMs: options.timeoutMs,
      runId: options.runId,
      tier: REPLY_JUDGE_TIER,
    });
    return {
      index: job.index,
      judgement: result.output,
      transcriptKeys: result.transcriptKeys ?? [result.transcriptKey],
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  } catch (error) {
    const keys = error instanceof HarnessError ? [...error.transcriptKeys] : [];
    return { index: job.index, error: errorText(error), transcriptKeys: keys };
  }
}

/** What the ticket checker's run on one ticket came to: a checklist, or why it failed. */
export interface TicketOutcome {
  index: number;
  coverage?: TicketCoverageResult;
  error?: string;
  transcriptKeys: string[];
  usage?: HarnessUsage;
}

/**
 * Runs the ticket checker on one ticket (its prompt from `buildTicketCoveragePrompt`), on the
 * fast tier. A failed run is an outcome with `error`, never a throw.
 */
export async function runTicketCheck(
  harness: Harness,
  job: { index: number; prompt: string },
  options: Omit<RunBatchOptions, "system">,
): Promise<TicketOutcome> {
  try {
    const result = await harness.run({
      prompt: job.prompt,
      cwd: options.cwd,
      schema: ticketCoverageSchema,
      model: options.model,
      timeoutMs: options.timeoutMs,
      runId: options.runId,
      tier: TICKET_CHECKER_TIER,
    });
    return {
      index: job.index,
      coverage: result.output,
      transcriptKeys: result.transcriptKeys ?? [result.transcriptKey],
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  } catch (error) {
    const keys = error instanceof HarnessError ? [...error.transcriptKeys] : [];
    return { index: job.index, error: errorText(error), transcriptKeys: keys };
  }
}

/** What the explainer's run on one finding came to: an answer, or why it failed. */
export interface ExplainOutcome {
  index: number;
  explanation?: Explanation;
  error?: string;
  transcriptKeys: string[];
  usage?: HarnessUsage;
}

/**
 * Runs the explainer on one finding (its prompt from `buildExplainPrompt`), on the fast tier. A
 * failed run is an outcome with `error`, never a throw.
 */
export async function runExplain(
  harness: Harness,
  job: { index: number; prompt: string },
  options: Omit<RunBatchOptions, "system">,
): Promise<ExplainOutcome> {
  try {
    const result = await harness.run({
      prompt: job.prompt,
      cwd: options.cwd,
      schema: explanationSchema,
      model: options.model,
      timeoutMs: options.timeoutMs,
      runId: options.runId,
      tier: EXPLAINER_TIER,
    });
    return {
      index: job.index,
      explanation: result.output,
      transcriptKeys: result.transcriptKeys ?? [result.transcriptKey],
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  } catch (error) {
    const keys = error instanceof HarnessError ? [...error.transcriptKeys] : [];
    return { index: job.index, error: errorText(error), transcriptKeys: keys };
  }
}

/** What the bootstrapper's run on one batch of comments came to: candidates, or why it failed. */
export interface BootstrapOutcome {
  index: number;
  candidates?: BootstrapCandidate[];
  error?: string;
  transcriptKeys: string[];
  usage?: HarnessUsage;
}

/**
 * Runs the bootstrapper (NIC-1080) on one batch of past review comments (its prompt from
 * `buildBootstrapPrompt`), on the fast tier. A failed run is an outcome with `error`, never a
 * throw.
 */
export async function runBootstrap(
  harness: Harness,
  job: { index: number; prompt: string },
  options: Omit<RunBatchOptions, "system">,
): Promise<BootstrapOutcome> {
  try {
    const result = await harness.run({
      prompt: job.prompt,
      cwd: options.cwd,
      schema: bootstrapOutputSchema,
      model: options.model,
      timeoutMs: options.timeoutMs,
      runId: options.runId,
      tier: BOOTSTRAPPER_TIER,
    });
    return {
      index: job.index,
      candidates: result.output.candidates,
      transcriptKeys: result.transcriptKeys ?? [result.transcriptKey],
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
  } catch (error) {
    const keys = error instanceof HarnessError ? [...error.transcriptKeys] : [];
    return { index: job.index, error: errorText(error), transcriptKeys: keys };
  }
}

/**
 * Places, deduplicates and decides on the batches' findings, and renders the summary: what would
 * be posted. `repo` is read for the cited code (blobs only, so a partial clone without a checkout
 * is enough); `latestHeadSha` is the PR's head now, to tell whether it moved during the run. A
 * batch with no outcome, or one that failed, makes the review incomplete.
 */
export async function finishReview(
  repo: Repo,
  prepared: PreparedReview,
  outcomes: readonly BatchOutcome[],
  latestHeadSha: string,
  options: FinishOptions = {},
): Promise<ReviewReport> {
  const { pr, plan, config } = prepared;
  const byIndex = new Map(outcomes.map((outcome) => [outcome.index, outcome]));
  const batches: BatchReport[] = [];
  const inline: Finding[] = [];
  const body: Finding[] = [];
  const misplaced: Finding[] = [];
  let overLimit = 0;
  // Files whose findings weren't all kept: not recorded as reviewed, so they're read again
  // next time rather than the cut findings being lost.
  const unsettled = new Set<string>();
  const place = (findings: readonly Finding[], batch: Batch) => {
    const placed = placeFindings(findings, batch);
    inline.push(...placed.inline);
    body.push(...placed.outsideDiff);
    misplaced.push(...placed.dropped);
    overLimit += placed.overLimit;
    // Past the per-batch limit, the dropped ones could be on any of its files.
    if (placed.overLimit > 0) for (const planned of batch.files) unsettled.add(planned.file.path);
    for (const finding of placed.dropped) unsettled.add(finding.path);
  };
  // Carried findings are placed on the PR's diff now, which may differ from the earlier run's.
  // Each resumed batch on its own files, so it keeps its own per-batch limit, and going over it
  // unsettles only its files.
  for (const carried of prepared.carried) {
    const own = new Set(carried.files);
    const files = plan.files.filter((planned) => own.has(planned.file.path));
    place(carried.findings, { index: -1, files, changedLines: 0 });
  }
  for (const job of prepared.jobs) {
    if (job.skipped === true) {
      batches.push({ index: job.index, files: job.files, skipped: true, transcriptKeys: [] });
      continue;
    }
    if (job.done === true) {
      batches.push({ index: job.index, files: job.files, done: true, transcriptKeys: [] });
      continue;
    }
    const outcome = byIndex.get(job.index);
    const report: BatchReport = {
      index: job.index,
      files: job.files,
      transcriptKeys: outcome?.transcriptKeys ?? [],
      ...(outcome?.usage === undefined ? {} : { usage: outcome.usage }),
    };
    const batch = plan.batches.find((candidate) => candidate.index === job.index);
    if (outcome?.findings === undefined || batch === undefined) {
      batches.push({ ...report, error: outcome?.error ?? "the batch produced no result" });
      continue;
    }
    place(outcome.findings, batch);
    batches.push(outcome.notes === undefined ? report : { ...report, notes: outcome.notes });
  }

  // The prompt-injection detector, in plain code over what the reviewer read: a hit on an added
  // line is a blocking finding there; one in the title, body or a comment holds approval.
  const injection = detectInjection(prepared, {
    allow: (config as Partial<RepoConfig>).injection?.allow ?? [],
    ...(options.ourAppId === undefined ? {} : { ourAppId: options.ourAppId }),
  });
  inline.push(...injection.findings);

  const statuses = batchFileStatuses(prepared, batches);

  // Duplicates: anything already raised on the PR, or twice in this run.
  const byPath = new Map(prepared.files.map((file) => [file.path, file]));
  const readLines = lineReader(repo);
  const partsOf = async (finding: Finding) => {
    const file = byPath.get(finding.path);
    const lines = await readLines(finding.side === "LEFT" ? file?.oldBlob : file?.newBlob);
    const start = finding.start_line ?? finding.line;
    return fingerprintParts({
      ruleCategory: finding.rule_category,
      path: finding.path,
      title: finding.title,
      code: citedCode(lines, finding.line, start),
      occurrence: codeOccurrence(lines, finding.line, start),
    });
  };
  // Our earlier open findings join the duplicate check ahead of the PR's comments, and our own
  // comment on one stands for it, so a re-raise is matched to the finding itself.
  const ours = options.earlier ?? [];
  const closed = options.closed ?? [];
  // A re-raise is matched to the fingerprint it's stored under (`storedOf` maps the others).
  const storedOf = new Map<string, string>();
  const oursKnown = await recordedKnown(ours, partsOf, storedOf);
  const closedKnown = await recordedKnown(closed, partsOf, storedOf);
  const comments = await knownFindings(prepared.comments, byPath, readLines, [...ours, ...closed]);
  const candidates = await Promise.all(
    [...inline, ...body].map(async (finding) => ({ finding, parts: await partsOf(finding) })),
  );
  const deduped = dedupeFindings(candidates, [...oursKnown, ...closedKnown, ...comments]);
  // Earlier findings stay open until their lines go (outdated) or a person resolves or declines
  // them: the reviewer is told not to repeat our comments, so its silence doesn't clear one.
  // One raised again more severely (dedupe matched it to the finding itself, never by line
  // alone) counts at the higher severity.
  const ourPrints = new Set(ours.map((entry) => entry.fingerprint));
  const raisedTo = new Map<string, Severity>();
  // Every earlier finding matched at all, at any severity.
  const reraisedPrints = new Set<string>();
  for (const dropped of deduped.dropped) {
    const { finding } = dropped;
    const matched = storedOf.get(dropped.matched) ?? dropped.matched;
    if (!ourPrints.has(matched)) continue;
    reraisedPrints.add(matched);
    const known =
      raisedTo.get(matched) ?? ours.find((e) => e.fingerprint === matched)?.finding.severity;
    if (known === undefined || severityRank(finding.severity) < severityRank(known)) {
      raisedTo.set(matched, finding.severity);
    }
  }
  const reraised = [...reraisedPrints];
  const escalated = ours.flatMap((entry) => {
    const severity = raisedTo.get(entry.fingerprint);
    return severity === undefined || severity === entry.finding.severity
      ? []
      : [{ fingerprint: entry.fingerprint, severity }];
  });
  const severityOf = new Map(escalated.map((entry) => [entry.fingerprint, entry.severity]));
  const earlier = ours.map((entry) => {
    const severity = severityOf.get(entry.fingerprint);
    return severity === undefined ? entry.finding : { ...entry.finding, severity };
  });
  // A new finding with the fingerprint of one we recorded before (outdated, say) is stored at
  // the more severe of the two, never lower: it's posted and counted at that severity too.
  const storedSeverity = new Map(
    (options.stored ?? []).map((entry) => [entry.fingerprint, entry.severity]),
  );
  const raised = new Map<Finding, Finding>();
  for (const { finding, fingerprint: print } of deduped.kept) {
    const severity = storedSeverity.get(print);
    if (severity !== undefined && severityRank(severity) < severityRank(finding.severity)) {
      raised.set(finding, { ...finding, severity });
    }
  }
  const final = (finding: Finding) => raised.get(finding) ?? finding;
  const posted = deduped.kept.map((entry) => ({ ...entry, finding: final(entry.finding) }));
  const kept = new Set(deduped.kept.map((entry) => entry.finding));
  const keptOf = (findings: readonly Finding[]) =>
    findings.filter((finding) => kept.has(finding)).map(final);
  // The earlier ones count once, as themselves; other reviewers' ones count too, but are ours
  // to neither post nor record.
  const others = options.others ?? [];
  const ownOpen = [...keptOf(inline), ...keptOf(body), ...earlier];
  const open = [...ownOpen, ...others.map((entry) => entry.finding)];

  const unreviewed = unreviewedReasons(plan.skipped);
  const failedBatches = batches.filter((batch) => batch.error !== undefined).length;
  const complete = failedBatches === 0 && unreviewed.length === 0;

  // A ticket's missing core requirements count as should-fix findings, capped: model judgement,
  // so they can hold approval but never block on their own.
  const tickets = ticketParts(options.tickets);
  const ticketsInjected = options.tickets?.injected ?? [];
  const decision = decide(
    [...open, ...Array.from({ length: tickets.gaps }, () => ({ severity: "should_fix" as const }))],
    {
      complete,
      // Text in the title, body, comments or linked tickets aimed at the reviewer. Hits on added
      // lines are blocking findings instead, which hold approval on their own.
      injectionFlagged: injection.text.length > 0 || ticketsInjected.length > 0,
      headMoved: latestHeadSha !== pr.headSha,
    },
    config,
  );
  const reasons = [
    ...(decision.outcome === "skipped" ? ["the PR's head moved during the run"] : []),
    ...(failedBatches > 0 ? [`${count(failedBatches, "batch", "batches")} failed`] : []),
    ...(decision.outcome === "skipped" ? [] : unreviewed),
    ...decision.holds.flatMap((hold) => holdReasons(hold, injection.text)),
    ...(decision.holds.includes("prompt_injection")
      ? ticketsInjected.map(
          (hit) =>
            `${HOLD_TEXT.prompt_injection} in ${TICKET_KEY.test(hit.key) ? `ticket ${hit.key}` : "a linked ticket"}: ${describeKinds(hit.kinds)}`,
        )
      : []),
    ...(tickets.gaps > 0
      ? [
          `${tickets.gaps === 1 ? "a linked ticket's core requirement looks" : `${tickets.gaps} of the linked tickets' core requirements look`} missing (see Ticket coverage)`,
        ]
      : []),
    ...((options.heldResolutions ?? 0) > 0
      ? [
          `${options.heldResolutions === 1 ? "a resolved review thread still counts" : `${options.heldResolutions} resolved review threads still count`}: a blocking or protected finding counts as resolved only when someone other than the PR's author, with write access, resolves it`,
        ]
      : []),
  ];
  const summary = renderSummary(
    {
      headSha: pr.headSha,
      files: prepared.files,
      plan,
      decision: {
        event: decision.event,
        ...(decision.label === undefined ? {} : { label: decision.label }),
        reasons,
      },
      findings: open,
      conventionFilesOmitted: prepared.conventionFilesOmitted,
      rulePackProblems: prepared.rulePackProblems ?? [],
      findingsOverLimit: overLimit,
      noLongerChanged: prepared.noLongerChanged,
      ...(tickets.table === undefined ? {} : { tickets: tickets.table }),
    },
    { maxLength: GITHUB_COMMENT_LIMIT - SUMMARY_MARKER_ROOM },
  );

  return {
    target: prepared.target,
    pr: {
      title: pr.title,
      author: pr.author,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
    },
    inline: keptOf(inline),
    body: keptOf(body),
    dropped: [
      ...misplaced.map((finding) => ({ finding, reason: "misplaced" as const })),
      ...deduped.dropped.map(({ finding }) => ({
        finding,
        reason: "duplicate" as const,
      })),
    ],
    overLimit,
    decision,
    complete,
    batches,
    plan: { reviewed: plan.files.length, skipped: plan.skipped.length },
    summary,
    kind: prepared.kind,
    posted,
    escalated,
    reraised,
    // Not a file with findings cut past the limit: one of those could have been the re-raise.
    reviewedNow: statuses.flatMap(({ file, status }) =>
      status === "reviewed" && !unsettled.has(file.path) ? [file.path] : [],
    ),
    reviewedFiles: reviewedFiles(prepared, statuses, unsettled),
    others: others.length,
    ticketGaps: tickets.gaps,
    misses: reviewerMisses(
      others,
      new Set(
        statuses.flatMap(({ file, status }) =>
          status === "reviewed" || status === "done" ? [file.path] : [],
        ),
      ),
      // Ours, open or closed, and those dropped as duplicates of a comment: all caught.
      [
        ...ownOpen,
        ...closed.map((entry) => entry.finding),
        ...deduped.dropped.map((entry) => entry.finding),
      ],
    ),
  };
}

/** A planned file, with how its batch went: `failed` when it produced no result. */
interface BatchFileStatus {
  file: FileDiff;
  depth: ReadingDepth;
  status: "reviewed" | "done" | "skipped" | "failed";
}

/**
 * Every planned file with how its batch went, in one walk of the plan. A file an earlier run
 * already reviewed is `done` (it wasn't in the prompt), read at the closer of the two depths.
 */
function batchFileStatuses(
  prepared: PreparedReview,
  batches: readonly BatchReport[],
): BatchFileStatus[] {
  const reports = new Map(batches.map((batch) => [batch.index, batch]));
  const doneDepth = new Map(prepared.done.map((entry) => [entry.path, entry.depth]));
  return prepared.plan.batches.flatMap((batch) => {
    const report = reports.get(batch.index);
    const failed = report === undefined || report.error !== undefined;
    return batch.files.map(({ file, depth }): BatchFileStatus => {
      const done = doneDepth.get(file.path);
      if (failed) return { file, depth, status: "failed" };
      // A done file keeps the closer depth it was read at before, also in a skipped batch.
      if (done !== undefined) return { file, depth: done, status: "done" };
      if (report.skipped === true) return { file, depth, status: "skipped" };
      return { file, depth, status: report.done === true ? "done" : "reviewed" };
    });
  });
}

/**
 * The file versions this run reviewed, to record: the files of batches that produced a result,
 * were done already, or only moved files, unless some of their findings were cut. Files whose
 * PR change hasn't moved since they were reviewed are covered at this head too, whatever
 * happened to the batches. Deleted files have no blob at head and aren't listed.
 */
function reviewedFiles(
  prepared: PreparedReview,
  statuses: readonly BatchFileStatus[],
  unsettled: ReadonlySet<string>,
): ReviewedFile[] {
  return [
    ...prepared.unchanged,
    ...statuses.flatMap(({ file, depth, status }) => {
      if (status === "failed" || unsettled.has(file.path)) return [];
      const blobSha = reviewedBlobOf(file);
      // Its earlier names (it was renamed since) are reviewed with it: the PR doesn't change
      // them any more.
      const names = (file.alsoReviewedAs ?? []).map((path) => ({
        path,
        blobSha: NOT_CHANGED,
        baseBlobSha: undefined,
        depth,
      }));
      return blobSha === undefined
        ? names
        : [{ path: file.path, blobSha, baseBlobSha: file.oldBlob, depth }, ...names];
    }),
  ];
}

/**
 * Reviews one PR on this machine and returns what would be posted, without posting anything:
 * clone, plan, a reviewer run per batch, placement, duplicate checks and the decision. The
 * review workflow (NIC-811) runs the same stages in separate tasks: `prepareReview`, `runBatch`
 * per batch in a sandbox, then `finishReview`.
 */
export async function runReview(deps: ReviewDeps, options: ReviewOptions): Promise<ReviewReport> {
  const { target } = options;
  const pr = await deps.github.pull(target);
  const work = await deps.workDir();
  try {
    deps.progress(`Cloning ${target.owner}/${target.repo} at ${pr.headSha.slice(0, 12)}…`);
    const repo = await deps.clone({
      url: deps.cloneUrl(target),
      dir: work.dir,
      headSha: pr.headSha,
      otherShas: [pr.baseSha],
      token: deps.token,
    });
    const prepared = await prepareReview(deps, target, repo, pr);
    const outcomes: BatchOutcome[] = [];
    for (const job of prepared.jobs) {
      if (job.prompt === undefined) continue;
      deps.progress(`Reviewing batch ${job.index + 1} of ${prepared.jobs.length}…`);
      outcomes.push(
        await runBatch(deps.harness, job, {
          cwd: work.dir,
          model: options.model,
          timeoutMs: options.batchTimeoutMs,
          runId: `${options.runId}-batch-${job.index}`,
          ...(prepared.reviewerSystem === undefined ? {} : { system: prepared.reviewerSystem }),
        }),
      );
    }
    const latest = await deps.github.pull(target);
    return await finishReview(repo, prepared, outcomes, latest.headSha);
  } finally {
    await work.remove();
  }
}
