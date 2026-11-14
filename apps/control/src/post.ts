import { statusLabels } from "@lgtmoose/config";
import type { ReviewEvent } from "@lgtmoose/core";
import {
  batchOutputSchema,
  finishReview,
  runKeys,
  type BatchOutcome,
  type ReviewReport,
} from "@lgtmoose/pipeline";
import { annotationsFor, buildReview, type PullRef } from "@lgtmoose/poster";
import { syncStatusLabel } from "@lgtmoose/summary";
import type { ControlDeps } from "./ports.js";
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
 * cut it short). So it checks, before posting and again before recording, that the run still
 * counts: `running()` (its execution isn't stopped), and the PR still open at the run's head.
 * If not, it posts nothing and leaves the PR's record alone for the run that replaced it.
 */
export async function post(
  deps: ControlDeps,
  runId: string,
  running: () => Promise<boolean> = async () => true,
): Promise<PostOutput> {
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

  /** Why the run no longer counts, if it doesn't, given the PR as GitHub has it now. */
  const stale = async (now: typeof latest): Promise<string | undefined> => {
    if (!(await running())) return "its execution was stopped";
    if (now.state !== "open") return "the PR is closed";
    if (now.headSha !== pr.headSha) return "the PR's head moved on";
    return undefined;
  };
  // The run won't post: it's superseded, by the run for the new head, or by nothing if the PR
  // closed. Marked here, since the dispatcher may not stop this execution (it may never see
  // the event that made it stale).
  const skip = async (reason: string): Promise<PostOutput> => {
    await deps.runs.supersedeRun(runId);
    deps.log("not posted", { runId, reason });
    const findings = report.inline.length + report.body.length;
    return { runId, posted: false, event: report.decision.event, complete: false, findings };
  };
  const before = await stale(latest);
  if (before !== undefined) return skip(before);

  const { decision } = report;
  const payload = buildReview({
    event: decision.event,
    inline: report.inline,
    outsideDiff: report.body,
    files: prepared.files,
    nitCap: config.gate.nit_cap,
  });
  await poster.submitReview(pull, pr.headSha, payload);
  if (decision.conclusion !== undefined) {
    await poster.completeCheckRun(pull, {
      headSha: pr.headSha,
      conclusion: decision.conclusion,
      title: CHECK_TITLE[decision.event],
      summary: report.summary,
      annotations: annotationsFor([...report.inline, ...report.body]),
    });
  }
  const comment = await poster.upsertSummaryComment(pull, report.summary, run.summaryCommentId);
  if (decision.label !== undefined) {
    const labels = await syncStatusLabel(poster.labels(pull), {
      target: decision.label,
      statusLabels: statusLabels(config),
    });
    if (!labels.ok) deps.log("label sync", { runId, problem: labels.problem });
  }

  // Posting takes a while: a stop or a push in the meantime means a newer run records the PR.
  const after = await stale(await github.reader.pull(target));
  if (after !== undefined) return skip(after);
  await deps.runs.succeedRun(runId, {
    filesDone: report.plan.reviewed,
    costUsd: costOf(report),
    headSha: pr.headSha,
    statusLabel: decision.label,
    summaryCommentId: comment.id ?? run.summaryCommentId,
  });
  deps.log("posted", { runId, event: decision.event, complete: report.complete });
  return {
    runId,
    posted: true,
    event: decision.event,
    complete: report.complete,
    findings: report.inline.length + report.body.length,
  };
}
