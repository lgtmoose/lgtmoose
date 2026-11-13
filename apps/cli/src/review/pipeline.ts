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
  loadRulePacks,
  placeFindings,
  readConventionFilesAt,
  type PullRequestComment,
} from "@lgtmoose/roles";
import { renderSummary } from "@lgtmoose/summary";
import type { PullComment, PullReader, PullRequest } from "./github.js";
import type { PullTarget } from "./target.js";

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
  batches: BatchReport[];
  plan: { reviewed: number; skipped: number };
  /** The summary comment that would be posted. */
  summary: string;
}

/** How many comments of each kind are read for context and duplicate checks. */
const COMMENT_LIMIT = 200;
/** Longest comment body passed to the model as context. */
const COMMENT_BODY_LIMIT = 4000;

const HOLD_TEXT: Record<HoldReason, string> = {
  incomplete: "the review didn't finish: some batches failed",
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

/**
 * Reviews one PR on this machine and returns what would be posted, without posting anything:
 * clone, plan, a reviewer run per batch, placement, duplicate checks and the decision.
 */
export async function runReview(deps: ReviewDeps, options: ReviewOptions): Promise<ReviewReport> {
  const { target } = options;
  const pr = await deps.github.pull(target);
  const comments = await deps.github.comments(target, COMMENT_LIMIT);
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
    const rulePacks = await loadRulePacks(config.rulepacks);
    deps.progress(
      `${count(plan.files.length, "file")} to review in ${count(plan.batches.length, "batch", "batches")}, ${plan.skipped.length} skipped.`,
    );

    const prompt = {
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
    const batches: BatchReport[] = [];
    const inline: Finding[] = [];
    const body: Finding[] = [];
    const misplaced: Finding[] = [];
    let overLimit = 0;
    for (const batch of plan.batches) {
      const files = batch.files.map((planned) => planned.file.path);
      if (batch.files.every((planned) => planned.depth === "move")) {
        batches.push({ index: batch.index, files, skipped: true, transcriptKeys: [] });
        continue;
      }
      deps.progress(`Reviewing batch ${batch.index + 1} of ${plan.batches.length}…`);
      try {
        const result = await deps.harness.run({
          prompt: buildReviewerPrompt({ ...prompt, batch }),
          cwd: work.dir,
          schema: reviewerOutputSchema,
          model: options.model,
          timeoutMs: options.batchTimeoutMs,
          runId: `${options.runId}-batch-${batch.index}`,
        });
        const placed = placeFindings(result.output.findings, batch);
        inline.push(...placed.inline);
        body.push(...placed.outsideDiff);
        misplaced.push(...placed.dropped);
        overLimit += placed.overLimit;
        batches.push({
          index: batch.index,
          files,
          transcriptKeys: result.transcriptKeys ?? [result.transcriptKey],
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        });
      } catch (error) {
        const keys = error instanceof HarnessError ? [...error.transcriptKeys] : [];
        batches.push({ index: batch.index, files, error: errorText(error), transcriptKeys: keys });
      }
    }

    // Duplicates: anything already raised on the PR, or twice in this run.
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    const readLines = lineReader(repo);
    const known = await knownFindings(comments, byPath, readLines);
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

    const latest = await deps.github.pull(target);
    const decision = decide(
      open,
      {
        complete: batches.every((batch) => batch.error === undefined),
        // No prompt-injection detector yet: the prompt tells the model to report attempts as
        // security findings instead.
        injectionFlagged: false,
        headMoved: latest.headSha !== pr.headSha,
      },
      config,
    );
    const reasons = [
      ...(decision.outcome === "skipped" ? ["the PR's head moved during the run"] : []),
      ...decision.holds.map((hold) => HOLD_TEXT[hold]),
    ];
    const summary = renderSummary({
      headSha: pr.headSha,
      files: diff.files,
      plan,
      decision: {
        event: decision.event,
        ...(decision.label === undefined ? {} : { label: decision.label }),
        reasons,
      },
      findings: open,
      conventionFilesOmitted: conventions.omitted,
      findingsOverLimit: overLimit,
    });

    return {
      target,
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
      batches,
      plan: { reviewed: plan.files.length, skipped: plan.skipped.length },
      summary,
    };
  } finally {
    await work.remove();
  }
}
