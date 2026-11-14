import { statusLabels } from "@lgtmoose/config";
import type { Finding, ReviewEvent } from "@lgtmoose/core";
import { diffCommits, trackLines, type Repo } from "@lgtmoose/git";
import {
  finishReview,
  runKeys,
  type BatchOutcome,
  type EarlierFinding,
  type ReviewReport,
} from "@lgtmoose/pipeline";
import { annotationsFor, buildReview, type PullRef } from "@lgtmoose/poster";
import { syncStatusLabel } from "@lgtmoose/summary";
import { readOutcome } from "./outcomes.js";
import type { ControlDeps, FindingRecord } from "./ports.js";
import { readManifest } from "./prepare.js";

/** What the post step did, for the log and the state machine. */
export interface PostOutput {
  runId: string;
  event: ReviewEvent;
  complete: boolean;
  /** New findings this run posted. */
  findings: number;
  /**
   * False when an incremental run found nothing new and the review on the PR already has this
   * run's event and label (never for an approval): no review posted.
   */
  reviewed: boolean;
}

const CHECK_TITLE: Record<ReviewEvent, string> = {
  APPROVE: "No changes needed",
  COMMENT: "Reviewed, not approved",
  REQUEST_CHANGES: "Changes requested",
};

function costOf(report: ReviewReport): number | undefined {
  const costs = report.batches.flatMap((batch) =>
    batch.usage?.costUsd === undefined ? [] : [batch.usage.costUsd],
  );
  return costs.length === 0 ? undefined : costs.reduce((sum, cost) => sum + cost, 0);
}

/**
 * Splits the PR's open findings into those still standing at `headSha`, moved to where their
 * lines are now, and those whose lines no longer exist (changed, deleted, or the PR no longer
 * changes the file): outdated. A finding on the old side stands while the PR still changes its
 * file. When the commit a finding was raised at is gone (force-pushed away), its lines can't be
 * followed, so it stands at its old place while the PR still changes the file.
 */
async function standing(
  repo: Repo,
  records: readonly FindingRecord[],
  mergeBase: string,
  headSha: string,
): Promise<{ open: EarlierFinding[]; outdated: string[] }> {
  if (records.length === 0) return { open: [], outdated: [] };
  const prFiles = await diffCommits(repo, mergeBase, headSha);
  // Old-side lines are in the PR while it changes the file (deleting it included); new-side
  // lines only while the file is still there at head.
  const changed = new Set(prFiles.map((file) => file.path));
  const atHead = new Set(prFiles.flatMap((file) => (file.status === "deleted" ? [] : [file.path])));
  const open: EarlierFinding[] = [];
  const outdated: string[] = [];
  const bySha = new Map<string, FindingRecord[]>();
  for (const record of records) {
    const group = bySha.get(record.raisedAtSha);
    if (group === undefined) bySha.set(record.raisedAtSha, [record]);
    else group.push(record);
  }
  for (const [sha, group] of bySha) {
    const right = group.filter((record) => record.side === "RIGHT");
    const followable = await repo.hasCommit(sha);
    const moved = followable
      ? await trackLines(
          repo,
          sha,
          headSha,
          right.map((record) => ({ path: record.path, line: record.line })),
        )
      : right.map((record) => ({ path: record.path, line: record.line }));
    const at = new Map(right.map((record, i) => [record, moved[i]]));
    for (const record of group) {
      const place =
        record.side === "RIGHT" ? at.get(record) : { path: record.path, line: record.line };
      const inPr = record.side === "RIGHT" ? atHead : changed;
      if (place === undefined || !inPr.has(place.path)) {
        outdated.push(record.id);
        continue;
      }
      const shift = place.line - record.line;
      const startLine = record.startLine === undefined ? undefined : record.startLine + shift;
      const finding: Finding = {
        rule_category: record.ruleCategory,
        severity: record.severity,
        path: place.path,
        line: place.line,
        side: record.side,
        ...(startLine === undefined || startLine < 1 ? {} : { start_line: startLine }),
        title: record.title,
        body: record.body,
        // Not kept: earlier findings are only counted and listed, never posted again.
        evidence: record.title,
      };
      open.push({ finding, fingerprint: record.fingerprint });
    }
  }
  return { open, outdated };
}

/**
 * The post step: reads the prepared review and every batch's output, finishes the review
 * (placement, duplicates, decision, summary) and posts it: one review, the check run, the
 * summary comment and the status label. In shadow mode the poster records instead.
 *
 * Our findings from earlier runs that are still open count towards the decision; those whose
 * lines are gone are marked outdated. An incremental run that found nothing new, and whose
 * decision is the review event and label already on the PR (other than an approval), posts no
 * review, but still updates the check run, the summary and the label, and records the head as
 * reviewed.
 */
export async function post(deps: ControlDeps, runId: string): Promise<PostOutput> {
  const run = await deps.runs.getRun(runId);
  if (run === undefined) throw new Error(`No review run ${runId}.`);
  const keys = runKeys(runId);
  const preparedText = await deps.store.getText(keys.prepared);
  if (preparedText === undefined) throw new Error(`Run ${runId} has no prepared review.`);
  const manifest = readManifest(preparedText);
  const prepared = manifest.review;
  const outcomes = (
    await Promise.all(
      prepared.jobs
        .filter((job) => job.prompt !== undefined)
        .map((job) => readOutcome(deps.store, runId, job.index)),
    )
  ).filter((outcome): outcome is BatchOutcome => outcome !== undefined);

  const { target, pr, config } = prepared;
  const pull: PullRef = { owner: target.owner, repo: target.repo, pull: target.number };
  const github = await deps.github(manifest.installationId);
  const poster = github.poster(runId, pull);
  const records = await deps.findings.openFindings(run.pullRequestId);
  const work = await deps.workDir();
  let report: ReviewReport;
  let outdated: string[];
  try {
    // Blobs only, for the cited code: no checkout. The commits earlier findings were raised at
    // are fetched too, to follow their lines.
    const repo = await deps.clone({
      url: deps.cloneUrl(target.owner, target.repo),
      dir: work.dir,
      headSha: pr.headSha,
      otherShas: [pr.baseSha, ...new Set(records.map((record) => record.raisedAtSha))],
      token: await github.token(),
      checkout: "none",
    });
    const earlier = await standing(repo, records, prepared.mergeBase, pr.headSha);
    outdated = earlier.outdated;
    const latest = await github.reader.pull(target);
    report = await finishReview(repo, prepared, outcomes, latest.headSha, {
      earlier: earlier.open,
    });
  } finally {
    await work.remove();
  }

  const { decision } = report;
  const fresh = report.inline.length + report.body.length;
  // Nothing to say when the review on GitHub already says it: same event, same label. An
  // approval is always posted again, since a push can dismiss the earlier one as stale.
  const quiet =
    report.kind === "incremental" &&
    fresh === 0 &&
    decision.label !== undefined &&
    decision.label === run.statusLabel &&
    decision.event === run.lastReviewEvent &&
    decision.event !== "APPROVE";
  if (!quiet) {
    const payload = buildReview({
      event: decision.event,
      inline: report.inline,
      outsideDiff: report.body,
      files: prepared.files,
      nitCap: config.gate.nit_cap,
    });
    await poster.submitReview(pull, pr.headSha, payload);
  }
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

  // Outdated first: a finding raised again at its new place (same fingerprint) is reopened.
  await deps.findings.markOutdated(outdated, pr.headSha);
  await deps.findings.saveFindings(run.pullRequestId, runId, pr.headSha, report.posted);
  await deps.runs.recordFiles(runId, report.reviewedFiles);
  // A failed batch's files weren't reviewed: the next incremental run starts from the last
  // complete one, so they're in its range again (the rest are done by blob).
  const batchFailed = report.batches.some((batch) => batch.error !== undefined);
  await deps.runs.succeedRun(runId, {
    filesDone: report.plan.reviewed,
    costUsd: costOf(report),
    reviewedSha: batchFailed ? undefined : pr.headSha,
    statusLabel: decision.label ?? run.statusLabel,
    summaryCommentId: comment.id ?? run.summaryCommentId,
    reviewEvent: quiet ? undefined : decision.event,
  });
  deps.log("posted", {
    runId,
    event: decision.event,
    complete: report.complete,
    reviewed: !quiet,
    outdated: outdated.length,
  });
  return {
    runId,
    event: decision.event,
    complete: report.complete,
    findings: fresh,
    reviewed: !quiet,
  };
}
