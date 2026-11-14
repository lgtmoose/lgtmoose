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
  type Finding,
  type HoldReason,
  type KnownFinding,
  type ReviewDecision,
} from "@lgtmoose/core";
import type { CloneOptions, FileDiff, Repo } from "@lgtmoose/git";
import { reviewDiff } from "@lgtmoose/git";
import { HarnessError, type Harness, type HarnessUsage } from "@lgtmoose/harness";
import { planReview, readHeaders, type Plan } from "@lgtmoose/planner";
import {
  buildReviewerPrompt,
  selectRulePacks,
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
}

/** One batch to review: its prompt, or `skipped` when every file in it was only moved. */
export interface BatchJob {
  index: number;
  files: string[];
  /** The reviewer prompt. Undefined for a skipped batch. */
  prompt?: string;
  skipped?: true;
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
    known.push({ fingerprint: fingerprint(parts), parts });
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
): Promise<PreparedReview> {
  const comments = await deps.github.comments(target, COMMENT_LIMIT);
  const config = await baseConfig(repo, pr.baseSha);
  const diff = await reviewDiff(repo, { baseSha: pr.baseSha });
  const headers = await readHeaders(repo, diff.files, {
    skip: config.skip,
    include: config.include,
  });
  const plan: Plan = planReview(diff.files, config, { headers });
  const conventions = await readConventionFilesAt(repo, pr.baseSha, {
    globs: config.conventions,
  });
  const selected = await selectRulePacks(config.rulepacks, { repo, baseSha: pr.baseSha });
  for (const problem of selected.problems) deps.progress(`Rule packs: ${problem}`);
  const rulePacks = selected.packs;
  deps.progress(
    `${count(plan.files.length, "file")} to review in ${count(plan.batches.length, "batch", "batches")}, ${plan.skipped.length} skipped.`,
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
    const files = batch.files.map((planned) => planned.file.path);
    if (batch.files.every((planned) => planned.depth === "move")) {
      return { index: batch.index, files, skipped: true };
    }
    return { index: batch.index, files, prompt: buildReviewerPrompt({ ...context, batch }) };
  });
  return {
    target,
    pr,
    comments,
    config,
    mergeBase: diff.mergeBase,
    files: diff.files,
    plan,
    conventionFilesOmitted: conventions.omitted,
    rulePackProblems: selected.problems,
    jobs,
  };
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
): Promise<ReviewReport> {
  const { pr, plan, config } = prepared;
  const byIndex = new Map(outcomes.map((outcome) => [outcome.index, outcome]));
  const batches: BatchReport[] = [];
  const inline: Finding[] = [];
  const body: Finding[] = [];
  const misplaced: Finding[] = [];
  let overLimit = 0;
  for (const job of prepared.jobs) {
    if (job.skipped === true) {
      batches.push({ index: job.index, files: job.files, skipped: true, transcriptKeys: [] });
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
    const placed = placeFindings(outcome.findings, batch);
    inline.push(...placed.inline);
    body.push(...placed.outsideDiff);
    misplaced.push(...placed.dropped);
    overLimit += placed.overLimit;
    batches.push(report);
  }

  // Duplicates: anything already raised on the PR, or twice in this run.
  const byPath = new Map(prepared.files.map((file) => [file.path, file]));
  const readLines = lineReader(repo);
  const known = await knownFindings(prepared.comments, byPath, readLines);
  const candidates = await Promise.all(
    [...inline, ...body].map(async (finding) => {
      const file = byPath.get(finding.path);
      const lines = await readLines(finding.side === "LEFT" ? file?.oldBlob : file?.newBlob);
      const start = finding.start_line ?? finding.line;
      return {
        finding,
        parts: fingerprintParts({
          ruleCategory: finding.rule_category,
          path: finding.path,
          title: finding.title,
          code: citedCode(lines, finding.line, start),
          occurrence: codeOccurrence(lines, finding.line, start),
        }),
      };
    }),
  );
  const deduped = dedupeFindings(candidates, known);
  const kept = new Set(deduped.kept.map((entry) => entry.finding));
  const open = [...inline, ...body].filter((finding) => kept.has(finding));

  // What the planner flagged for a person: new code it skipped, and lockfile changes it
  // couldn't review. No findings there doesn't mean nothing is wrong, so they hold approval.
  const unreviewed = [
    ...(plan.skipped.some((entry) => entry.newCode === true)
      ? ["new code in vendored, build or generated paths wasn't reviewed"]
      : []),
    ...(plan.skipped.some((entry) => (entry.notes?.length ?? 0) > 0)
      ? ["dependency changes in lockfiles need a person to check them"]
      : []),
  ];
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
    rulePackProblems: prepared.rulePackProblems ?? [],
    findingsOverLimit: overLimit,
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
      ...deduped.dropped.map(({ finding }) => ({ finding, reason: "duplicate" as const })),
    ],
    overLimit,
    decision,
    complete,
    batches,
    plan: { reviewed: plan.files.length, skipped: plan.skipped.length },
    summary,
  };
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
      if (job.skipped === true) continue;
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
