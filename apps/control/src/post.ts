import { randomUUID } from "node:crypto";
import { statusLabels } from "@lgtmoose/config";
import type { ReviewEvent } from "@lgtmoose/core";
import {
  batchOutputSchema,
  finishReview,
  runKeys,
  type BatchOutcome,
  type ReviewReport,
} from "@lgtmoose/pipeline";
import { GitHubError, annotationsFor, buildReview, type PullRef } from "@lgtmoose/poster";
import { syncStatusLabel } from "@lgtmoose/summary";
import { z } from "zod";
import type { ControlDeps } from "./ports.js";
import { TASK_MISSING } from "./ecs.js";
import type { RunManifest } from "./prepare.js";

/** What the post step did, for the log and the state machine. */
export interface PostOutput {
  runId: string;
  /**
   * False when the run stopped counting before it posted: its execution was stopped, the PR's
   * head moved on or the PR closed. Nothing was posted or recorded then.
   */
  posted: boolean;
  event: ReviewEvent;
  complete: boolean;
  findings: number;
}

const CHECK_TITLE: Record<ReviewEvent, string> = {
  APPROVE: "No changes needed",
  COMMENT: "Reviewed, not approved",
  REQUEST_CHANGES: "Changes requested",
};

/**
 * One batch's outcome from its output object. A missing object (the sandbox task failed or
 * never ran) or one that doesn't validate counts as a failed batch, never as a clean one.
 */
async function readOutcome(
  deps: ControlDeps,
  runId: string,
  index: number,
): Promise<BatchOutcome | undefined> {
  const text = await deps.store.getText(runKeys(runId).batchOutput(index));
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { index, error: "the batch output isn't JSON", transcriptKeys: [] };
  }
  const parsed = batchOutputSchema.safeParse(json);
  if (!parsed.success || parsed.data.index !== index) {
    return { index, error: "the batch output doesn't match its schema", transcriptKeys: [] };
  }
  const { findings, error, transcriptKeys, usage } = parsed.data;
  return {
    index,
    ...(findings === undefined ? {} : { findings }),
    ...(error === undefined ? {} : { error }),
    transcriptKeys,
    ...(usage === undefined ? {} : { usage: withoutUndefined(usage) }),
  };
}

function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/** What the post step has posted for a run, so far. */
interface PostProgress {
  review?: boolean;
  checkRun?: boolean;
  summary?: boolean;
  summaryCommentId?: number;
  label?: boolean;
}

const postProgressSchema = z.object({
  review: z.boolean().optional(),
  checkRun: z.boolean().optional(),
  summary: z.boolean().optional(),
  summaryCommentId: z.number().int().positive().optional(),
  label: z.boolean().optional(),
});

/**
 * An earlier attempt's progress. Progress that's there but can't be read fails the step: a
 * retry mustn't assume nothing was posted.
 */
function readProgress(text: string | undefined): PostProgress {
  if (text === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The post step's saved progress isn't JSON.");
  }
  const parsed = postProgressSchema.safeParse(json);
  if (!parsed.success) throw new Error("The post step's saved progress doesn't match its schema.");
  return withoutUndefined(parsed.data);
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The hidden marker in a run's review, by which a retry finds it on GitHub. */
export function reviewMarker(runId: string): string {
  return `lgtmoose-run:${runId}`;
}

/** Who a post attempt is, for the review claim. */
export interface PostAttempt {
  /** Unique to the attempt. */
  id: string;
  /** The ECS task running it; undefined off ECS. */
  taskArn: string | undefined;
}

/** What `post` needs besides the control task's dependencies. */
export interface PostOptions {
  /** Whether the run's execution is still running (not stopped). */
  running?: () => Promise<boolean>;
  /** This attempt. */
  attempt?: PostAttempt;
  /** An ECS task's last status (RUNNING, STOPPED…, or MISSING), for a claim's holder. */
  taskStatus?: (taskArn: string) => Promise<string>;
}

const claimSchema = z.object({ attempt: z.string(), taskArn: z.string().optional() });

/**
 * A claim's holder is done with it: its containers have stopped (DEPROVISIONING comes after
 * STOPPING, as the task's network is torn down), the task has stopped or been deleted, or ECS
 * no longer knows it. A task still DEACTIVATING or STOPPING may yet be running its process.
 */
const HOLDER_GONE = new Set(["DEPROVISIONING", "STOPPED", "DELETED", TASK_MISSING]);

/** The summary comment's hidden marker: one per PR, so any run finds the PR's comment. */
export const SUMMARY_MARKER = "lgtmoose-summary";

/**
 * Claims the run's review for this attempt before it posts it, so two attempts (a retry and
 * the attempt it replaced, still alive) can't both post. The claim names the attempt's ECS
 * task. Returns the claim's ETag when this attempt holds it and should post, or "posted" when
 * the review is already on GitHub. When another attempt holds it and hasn't posted:
 * - its task has stopped (or is gone): the claim is taken over, with a write conditional on
 *   the claim being unchanged, so two attempts can't both take it over;
 * - its task is still running, or can't be told: the step fails, and its retry tries later.
 */
async function claimReview(
  deps: ControlDeps,
  options: { attempt: PostAttempt; taskStatus: (taskArn: string) => Promise<string> },
  reviewPosted: () => Promise<boolean>,
  claimKey: string,
): Promise<{ etag: string } | "posted"> {
  const mine = JSON.stringify({
    attempt: options.attempt.id,
    ...(options.attempt.taskArn === undefined ? {} : { taskArn: options.attempt.taskArn }),
  });
  const created = await deps.store.createText(claimKey, mine);
  if (created !== undefined) return { etag: created };
  if (await reviewPosted()) return "posted";
  const current = await deps.store.getTagged(claimKey);
  // Released since: claim it afresh, once.
  if (current === undefined) {
    const again = await deps.store.createText(claimKey, mine);
    if (again !== undefined) return { etag: again };
    throw new Error("Another attempt claimed this run's review just now.");
  }
  const holder = claimSchema.safeParse(parseJson(current.text));
  const holderTask = holder.success ? holder.data.taskArn : undefined;
  if (holder.success && holderTask === undefined) {
    throw new Error("Another attempt, off ECS, holds this run's review claim.");
  }
  // An unreadable claim has no holder to wait for.
  if (holderTask !== undefined) {
    const status = await options.taskStatus(holderTask);
    if (!HOLDER_GONE.has(status)) {
      throw new Error(`Another attempt (task ${status}) holds this run's review claim.`);
    }
    // It may have posted just before it stopped.
    if (await reviewPosted()) return "posted";
  }
  const taken = await deps.store.replaceText(claimKey, mine, current.etag);
  if (taken === undefined) throw new Error("Another attempt took over this run's review claim.");
  deps.log("took over the review claim of a stopped attempt", { holderTask });
  return { etag: taken };
}

/** GitHub refused the request outright: it wasn't carried out, so nothing was posted. */
function refused(error: unknown): boolean {
  return error instanceof GitHubError && error.status >= 400 && error.status < 500;
}

/** Why a run for `headSha` no longer counts, given the PR as GitHub has it now. */
function staleReason(now: { state: string; headSha: string }, headSha: string): string | undefined {
  if (now.state !== "open") return "the PR is closed";
  if (now.headSha !== headSha) return "the PR's head moved on";
  return undefined;
}

function costOf(report: ReviewReport): number | undefined {
  const costs = report.batches.flatMap((batch) =>
    batch.usage?.costUsd === undefined ? [] : [batch.usage.costUsd],
  );
  return costs.length === 0 ? undefined : costs.reduce((sum, cost) => sum + cost, 0);
}

/**
 * The post step: reads the prepared review and every batch's output, finishes the review
 * (placement, duplicates, decision, summary) and posts it: one review, the check run, the
 * summary comment and the status label. In shadow mode the poster records instead.
 *
 * A stopped execution's post task keeps running (it waits for a task token, so a stop can't
 * cut it short). So before its first write to GitHub it checks that the run still counts:
 * `running()` (its execution isn't stopped), and the PR still open at the run's head. If not,
 * it posts nothing and marks the run superseded. Once it has written anything it records what
 * it posted; `succeedRun` leaves the PR's record to a newer run that has already posted.
 */
export async function post(
  deps: ControlDeps,
  runId: string,
  options: PostOptions = {},
): Promise<PostOutput> {
  const running = options.running ?? (async () => true);
  const attempt = options.attempt ?? { id: randomUUID(), taskArn: undefined };
  const taskStatus = options.taskStatus ?? (async () => TASK_MISSING);
  const run = await deps.runs.getRun(runId);
  if (run === undefined) throw new Error(`No review run ${runId}.`);
  const keys = runKeys(runId);
  const preparedText = await deps.store.getText(keys.prepared);
  if (preparedText === undefined) throw new Error(`Run ${runId} has no prepared review.`);
  // Written by this run's own prepare step with the control task's role: trusted, not model output.
  const manifest = JSON.parse(preparedText) as RunManifest;
  const prepared = manifest.review;
  const outcomes = (
    await Promise.all(
      prepared.jobs
        .filter((job) => job.prompt !== undefined)
        .map((job) => readOutcome(deps, runId, job.index)),
    )
  ).filter((outcome): outcome is BatchOutcome => outcome !== undefined);

  const { target, pr, config } = prepared;
  const pull: PullRef = { owner: target.owner, repo: target.repo, pull: target.number };
  const github = await deps.github(manifest.installationId);
  const poster = github.poster(runId, pull);
  const work = await deps.workDir();
  let report: ReviewReport;
  let latest: Awaited<ReturnType<typeof github.reader.pull>>;
  try {
    // Blobs only, for the cited code: no checkout.
    const repo = await deps.clone({
      url: deps.cloneUrl(target.owner, target.repo),
      dir: work.dir,
      headSha: pr.headSha,
      otherShas: [pr.baseSha],
      token: await github.token(),
      checkout: "none",
    });
    latest = await github.reader.pull(target);
    report = await finishReview(repo, prepared, outcomes, latest.headSha);
  } finally {
    await work.remove();
  }

  // Why the run no longer counts, if it doesn't. Marked superseded here, since the dispatcher
  // may never stop this execution (it may not have seen the event that made it stale).
  // What an earlier attempt of this step posted: a retry carries on from there, and once the
  // review is posted the run is recorded whatever happens to the PR meanwhile.
  const saved = await deps.store.getTagged(keys.posted);
  const progress = readProgress(saved?.text);
  // Each save is conditional on the version this attempt last wrote (or read), so two
  // overlapping attempts can't overwrite each other's progress: the second fails its step.
  let progressEtag = saved?.etag;
  const save = async () => {
    const body = JSON.stringify(progress);
    const etag =
      progressEtag === undefined
        ? await deps.store.createText(keys.posted, body)
        : await deps.store.replaceText(keys.posted, body, progressEtag);
    if (etag === undefined)
      throw new Error("Another attempt saved this post's progress meanwhile.");
    progressEtag = etag;
  };

  let stale: string | undefined;
  if (!progress.review) {
    stale = (await running()) ? staleReason(latest, pr.headSha) : "its execution was stopped";
  }
  if (stale !== undefined) {
    await deps.runs.supersedeRun(runId);
    deps.log("not posted", { runId, reason: stale });
    const findings = report.inline.length + report.body.length;
    return { runId, posted: false, event: report.decision.event, complete: false, findings };
  }

  const { decision } = report;
  const payload = buildReview({
    event: decision.event,
    inline: report.inline,
    outsideDiff: report.body,
    files: prepared.files,
    nitCap: config.gate.nit_cap,
    marker: reviewMarker(runId),
  });
  const record = () =>
    deps.runs.succeedRun(runId, {
      filesDone: report.plan.reviewed,
      costUsd: costOf(report),
      headSha: pr.headSha,
      // The label it set, or meant to: the reconciler re-syncs a label that didn't take.
      statusLabel: decision.label,
      summaryCommentId: progress.summaryCommentId ?? run.summaryCommentId,
    });
  try {
    if (!progress.review) {
      const claim = await claimReview(
        deps,
        { attempt, taskStatus },
        () => github.reviewPosted(pull, reviewMarker(runId)),
        keys.reviewClaim,
      );
      if (claim !== "posted") {
        try {
          await poster.submitReview(pull, pr.headSha, payload);
        } catch (error) {
          // Refused, it's not on GitHub: let the next attempt claim it at once. Otherwise
          // (a timeout, a 5xx) it may be, and the claim stays until this task has stopped.
          if (refused(error)) {
            await deps.store
              .deleteIfMatch(keys.reviewClaim, claim.etag)
              .catch((release: unknown) => {
                deps.log("releasing the review claim failed", {
                  runId,
                  error: release instanceof Error ? release.message : String(release),
                });
              });
          }
          throw error;
        }
      }
      // Posted, by this attempt or by one that died before it saved its progress.
      progress.review = true;
      await save();
    }
    if (decision.conclusion !== undefined && !progress.checkRun) {
      await poster.completeCheckRun(pull, {
        headSha: pr.headSha,
        conclusion: decision.conclusion,
        title: CHECK_TITLE[decision.event],
        summary: report.summary,
        annotations: annotationsFor([...report.inline, ...report.body]),
        // A retry finds the run an earlier attempt created, instead of adding another.
        externalId: runId,
      });
      progress.checkRun = true;
      await save();
    }
    // The summary comment and the label are the PR's, not this head's: once a newer run has
    // posted they're its, and an older run finishing late leaves them alone.
    // Checked right before each write: a newer run may finish posting in between.
    if (!progress.summary && !(await deps.runs.newerRunPosted(runId))) {
      const summaryId = progress.summaryCommentId ?? run.summaryCommentId;
      // Found by its marker when there's no stored ID, so a retry edits the comment an
      // earlier attempt created.
      const comment = await poster.upsertSummaryComment(
        pull,
        report.summary,
        summaryId,
        SUMMARY_MARKER,
      );
      const id = comment.id ?? summaryId;
      if (id !== undefined) progress.summaryCommentId = id;
      progress.summary = true;
      await save();
    }
    if (
      decision.label !== undefined &&
      !progress.label &&
      !(await deps.runs.newerRunPosted(runId))
    ) {
      const labels = await syncStatusLabel(poster.labels(pull), {
        target: decision.label,
        statusLabels: statusLabels(config),
      });
      if (!labels.ok) deps.log("label sync", { runId, problem: labels.problem });
      progress.label = true;
      await save();
    }
  } catch (error) {
    // The review is on GitHub: record the run, with the summary comment if it got that far, so
    // a later run edits that comment and doesn't review the head again. Then fail the step,
    // whose retry finishes the rest.
    if (progress.review) {
      await record().catch((recordError: unknown) => {
        deps.log("recording a partly posted run failed", {
          runId,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      });
    }
    throw error;
  }

  await record();
  deps.log("posted", { runId, event: decision.event, complete: report.complete });
  return {
    runId,
    posted: true,
    event: decision.event,
    complete: report.complete,
    findings: report.inline.length + report.body.length,
  };
}
