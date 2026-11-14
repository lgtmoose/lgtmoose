import { parseRepoConfigYaml, type RepoConfig } from "@lgtmoose/config";
import {
  citedCode,
  codeOccurrence,
  commentTitle,
  decide,
  dedupeFindings,
  fingerprint,
  fingerprintParts,
  reviewerOutputSchema,
  severityRank,
  type Finding,
  type HoldReason,
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
  buildReviewerPrompt,
  loadRulePacks,
  placeFindings,
  readConventionFilesAt,
  type PullRequestComment,
} from "@lgtmoose/roles";
import { renderSummary } from "@lgtmoose/summary";
import type { PullComment, PullReader, PullRequest, PullTarget } from "./pull.js";

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
  /** File versions this run reviewed, to record so a later run can skip them. */
  reviewedFiles: ReviewedFile[];
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
}

export interface FinishOptions {
  /**
   * Findings earlier runs posted that are still open. They count towards the decision and are
   * listed in the summary; a new finding with the same fingerprint isn't posted again.
   */
  earlier?: readonly EarlierFinding[];
  /**
   * Findings a person resolved or declined, at their recorded place. The person's decision
   * wins: a re-raise matching one (its fingerprint, stored or at that place, or a duplicate of
   * its comment) is dropped, and doesn't count.
   */
  closed?: readonly EarlierFinding[];
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
  /** One entry per planned batch, in order. */
  jobs: BatchJob[];
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
}

/** What one batch's reviewer run returned. Findings are placed and checked in `finishReview`. */
export interface BatchOutcome {
  index: number;
  /** The model's findings, validated with `reviewerOutputSchema`. Undefined when it failed. */
  findings?: Finding[];
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

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function errorText(error: unknown): string {
  if (error instanceof HarnessError) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export interface PrepareDeps {
  github: PullReader;
  progress(line: string): void;
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
  const rulePacks = await loadRulePacks(config.rulepacks);
  const { done, carried } = doneFiles(plan, options);
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
    comments: contextComments(comments),
    conventions: conventions.files,
    rulePacks,
  };
  const jobs: BatchJob[] = plan.batches.map((batch) => {
    const paths = batch.files.map((planned) => planned.file.path);
    if (batch.files.every((planned) => planned.depth === "move")) {
      return { index: batch.index, files: paths, skipped: true };
    }
    const todo = batch.files.filter((planned) => !done.has(planned.file.path));
    if (todo.every((planned) => planned.depth === "move")) {
      return { index: batch.index, files: paths, done: true };
    }
    const prompt = buildReviewerPrompt({ ...context, batch: { ...batch, files: todo } });
    return { index: batch.index, files: paths, prompt };
  });
  return {
    target,
    pr,
    comments,
    config,
    mergeBase: diff.mergeBase,
    files,
    plan,
    conventionFilesOmitted: conventions.omitted,
    jobs,
    kind: diff.kind,
    ...(diff.fallbackReason === undefined ? {} : { fallbackReason: diff.fallbackReason }),
    done: [...done].map(([path, depth]) => ({ path, depth })),
    carried,
    unchanged,
    noLongerChanged: diff.noLongerChanged,
  };
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
      cwd: options.cwd,
      schema: reviewerOutputSchema,
      model: options.model,
      timeoutMs: options.timeoutMs,
      runId: options.runId,
    });
    return {
      index: job.index,
      findings: result.output.findings,
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
    batches.push(report);
  }

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
  // Each under its stored fingerprint and under the one at its place now (after a rename or a
  // shift), so an exact re-raise matches either way; protected categories only match exactly.
  const storedOf = new Map<string, string>();
  const oursKnown = (
    await Promise.all(
      ours.map(async (entry) => {
        const parts = await partsOf(entry.finding);
        const here = fingerprint(parts);
        if (here !== entry.fingerprint) storedOf.set(here, entry.fingerprint);
        return [
          { fingerprint: entry.fingerprint, parts },
          ...(here === entry.fingerprint ? [] : [{ fingerprint: here, parts }]),
        ];
      }),
    )
  ).flat();
  const closed = options.closed ?? [];
  const closedKnown = (
    await Promise.all(
      closed.map(async (entry) => {
        const parts = await partsOf(entry.finding);
        const here = fingerprint(parts);
        return [
          { fingerprint: entry.fingerprint, parts },
          ...(here === entry.fingerprint ? [] : [{ fingerprint: here, parts }]),
        ];
      }),
    )
  ).flat();
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
  for (const dropped of deduped.dropped) {
    const { finding } = dropped;
    const matched = storedOf.get(dropped.matched) ?? dropped.matched;
    if (!ourPrints.has(matched)) continue;
    const known =
      raisedTo.get(matched) ?? ours.find((e) => e.fingerprint === matched)?.finding.severity;
    if (known === undefined || severityRank(finding.severity) < severityRank(known)) {
      raisedTo.set(matched, finding.severity);
    }
  }
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
  const posted = deduped.kept;
  const kept = new Set(posted.map((entry) => entry.finding));
  // The earlier ones count once, as themselves.
  const open = [...[...inline, ...body].filter((finding) => kept.has(finding)), ...earlier];

  const unreviewed = unreviewedReasons(plan.skipped);
  const failedBatches = batches.filter((batch) => batch.error !== undefined).length;
  const complete = failedBatches === 0 && unreviewed.length === 0;

  const decision = decide(
    open,
    {
      complete,
      // No prompt-injection detector yet: the prompt tells the model to report attempts as
      // security findings instead.
      injectionFlagged: false,
      headMoved: latestHeadSha !== pr.headSha,
    },
    config,
  );
  const reasons = [
    ...(decision.outcome === "skipped" ? ["the PR's head moved during the run"] : []),
    ...(failedBatches > 0 ? [`${count(failedBatches, "batch", "batches")} failed`] : []),
    ...(decision.outcome === "skipped" ? [] : unreviewed),
    ...decision.holds.flatMap((hold) => (hold === "incomplete" ? [] : [HOLD_TEXT[hold]])),
  ];
  const summary = renderSummary({
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
    findingsOverLimit: overLimit,
    noLongerChanged: prepared.noLongerChanged,
  });

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
    inline: inline.filter((finding) => kept.has(finding)),
    body: body.filter((finding) => kept.has(finding)),
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
    reviewedFiles: reviewedFiles(prepared, statuses, unsettled),
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
        }),
      );
    }
    const latest = await deps.github.pull(target);
    return await finishReview(repo, prepared, outcomes, latest.headSha);
  } finally {
    await work.remove();
  }
}
