import { statusLabels } from "@lgtmoose/config";
import type { Finding, ReviewEvent } from "@lgtmoose/core";
import { diffCommits, trackLines, type FileDiff, type LineRef, type Repo } from "@lgtmoose/git";
import {
  finishReview,
  runKeys,
  type BatchOutcome,
  type EarlierFinding,
  type PullReader,
  type PullTarget,
  type ReviewReport,
} from "@lgtmoose/pipeline";
import { annotationsFor, buildReview, type PullRef } from "@lgtmoose/poster";
import { syncStatusLabel } from "@lgtmoose/summary";
import { readOutcome } from "./outcomes.js";
import type { ControlDeps, FindingRecord, RunRecord } from "./ports.js";
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
 * The findings to follow to the new head: open ones, and outdated ones only while the PR still
 * changes their file (so they could stand again). Outdated findings on files the PR left alone
 * stay as they are, which keeps the work from growing with the PR's age.
 */
function toTrack(records: readonly FindingRecord[], prFiles: readonly FileDiff[]): FindingRecord[] {
  const { changed, atHead } = prPaths(prFiles);
  return records.filter(
    (record) =>
      record.status === "open" || (record.side === "RIGHT" ? atHead : changed).has(record.path),
  );
}

/** Paths the PR changes (deleting included), and those of them still there at head. */
function prPaths(prFiles: readonly FileDiff[]): { changed: Set<string>; atHead: Set<string> } {
  return {
    changed: new Set(prFiles.map((file) => file.path)),
    atHead: new Set(prFiles.flatMap((file) => (file.status === "deleted" ? [] : [file.path]))),
  };
}

/**
 * Splits the PR's tracked findings into those standing at `headSha`, moved to where their lines
 * are now, and those whose lines don't exist there (changed, deleted, or the PR no longer
 * changes the file). Open findings that no longer stand are `outdated`; outdated ones that stand
 * again, such as after a fix is reverted, are `reopened`.
 *
 * A finding on the old side is on a line the PR deletes. It's followed from the base the PR had
 * when it was raised (its merge base with today's) to today's merge base, and stands while the
 * PR still deletes that line. When the commit a finding was raised at is gone (force-pushed
 * away), its lines can't be followed: an open one stands at its old place while the PR still
 * changes the file, and an outdated one stays outdated.
 */
async function standing(
  repo: Repo,
  records: readonly FindingRecord[],
  prFiles: readonly FileDiff[],
  mergeBase: string,
  headSha: string,
): Promise<{ open: EarlierFinding[]; outdated: string[]; reopened: string[] }> {
  if (records.length === 0) return { open: [], outdated: [], reopened: [] };
  const { changed, atHead } = prPaths(prFiles);
  const deletedLines = new Map(
    prFiles.map((file) => [
      file.path,
      new Set(
        file.hunks.flatMap((hunk) =>
          hunk.lines.flatMap((line) =>
            line.kind === "del" && line.oldLine !== undefined ? [line.oldLine] : [],
          ),
        ),
      ),
    ]),
  );
  const open: EarlierFinding[] = [];
  const outdated: string[] = [];
  const reopened: string[] = [];
  const bySha = new Map<string, FindingRecord[]>();
  for (const record of records) {
    const group = bySha.get(record.raisedAtSha);
    if (group === undefined) bySha.set(record.raisedAtSha, [record]);
    else group.push(record);
  }
  const refs = (list: readonly FindingRecord[]) =>
    list.map((record) => ({ path: record.path, line: record.line }));
  for (const [sha, group] of bySha) {
    const right = group.filter((record) => record.side === "RIGHT");
    const left = group.filter((record) => record.side === "LEFT");
    const followable = await repo.hasCommit(sha);
    const movedRight = followable ? await trackLines(repo, sha, headSha, refs(right)) : refs(right);
    let movedLeft: (LineRef | undefined)[] = refs(left);
    if (followable && left.length > 0) {
      const raisedBase = (await repo.git(["merge-base", sha, mergeBase])).trim();
      movedLeft = await trackLines(repo, raisedBase, mergeBase, refs(left));
    }
    const at = new Map([
      ...right.map((record, i) => [record, movedRight[i]] as const),
      ...left.map((record, i) => [record, movedLeft[i]] as const),
    ]);
    for (const record of group) {
      const isLeft = record.side === "LEFT";
      const place = at.get(record);
      const inPr = place !== undefined && (isLeft ? changed : atHead).has(place.path);
      // Followed: the line must still exist (new side) or still be deleted (old side). Not
      // followable: an open finding keeps its place while its file is in the PR.
      const followed =
        place !== undefined &&
        (!isLeft || (deletedLines.get(place.path)?.has(place.line) ?? false));
      const stands = inPr && (followable ? followed : record.status === "open");
      if (!stands) {
        if (record.status === "open") outdated.push(record.id);
        continue;
      }
      if (record.status === "outdated") reopened.push(record.id);
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
  return { open, outdated, reopened };
}

/**
 * Whether the approval we posted last still stands on GitHub. A push can dismiss it as stale,
 * so after one it's checked; unknown (shadow mode, no ID, the read failed) counts as not.
 */
async function approvalStands(
  reader: PullReader,
  target: PullTarget,
  run: RunRecord,
  headSha: string,
): Promise<boolean> {
  if (run.lastReviewEvent !== "APPROVE") return false;
  // Nothing was pushed since: nothing could have dismissed it.
  if (run.lastReviewedSha === headSha) return true;
  if (run.lastReviewId === undefined || reader.reviewState === undefined) return false;
  try {
    return (await reader.reviewState(target, run.lastReviewId)) === "APPROVED";
  } catch {
    return false;
  }
}

/**
 * The post step: reads the prepared review and every batch's output, finishes the review
 * (placement, duplicates, decision, summary) and posts it: one review, the check run, the
 * summary comment and the status label. In shadow mode the poster records instead.
 *
 * Our findings from earlier runs that are still open count towards the decision; those whose
 * lines are gone are marked outdated, and outdated ones whose lines are back are reopened. An
 * incremental run that found nothing new, and whose decision is the review event and label
 * already on the PR (for an approval, one that still stands), posts no review, but still
 * updates the check run, the summary and the label, and records the head as reviewed.
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
  const records = await deps.findings.trackedFindings(run.pullRequestId);
  const work = await deps.workDir();
  let report: ReviewReport;
  let outdated: string[];
  let reopened: string[];
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
    const prFiles = await diffCommits(repo, prepared.mergeBase, pr.headSha);
    const tracked = toTrack(records, prFiles);
    // The commits those findings were raised at, to follow their lines: one request.
    await repo.fetchCommits(tracked.map((record) => record.raisedAtSha));
    const earlier = await standing(repo, tracked, prFiles, prepared.mergeBase, pr.headSha);
    ({ outdated, reopened } = earlier);
    const latest = await github.reader.pull(target);
    report = await finishReview(repo, prepared, outcomes, latest.headSha, {
      earlier: earlier.open,
    });
  } finally {
    await work.remove();
  }

  const { decision } = report;
  const fresh = report.inline.length + report.body.length;
  // Nothing to say when the review on GitHub already says it: same event, same label, and for
  // an approval, one that still stands (a push can dismiss it as stale).
  const quiet =
    report.kind === "incremental" &&
    fresh === 0 &&
    decision.label !== undefined &&
    decision.label === run.statusLabel &&
    decision.event === run.lastReviewEvent &&
    (decision.event !== "APPROVE" ||
      (await approvalStands(github.reader, target, run, pr.headSha)));
  let posted: { event: ReviewEvent; id: number | undefined } | undefined;
  if (!quiet) {
    const payload = buildReview({
      event: decision.event,
      inline: report.inline,
      outsideDiff: report.body,
      files: prepared.files,
      nitCap: config.gate.nit_cap,
    });
    const review = await poster.submitReview(pull, pr.headSha, payload);
    posted = { event: decision.event, id: review.id };
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
  await deps.findings.reopen(reopened, pr.headSha);
  await deps.findings.saveFindings(run.pullRequestId, runId, pr.headSha, report.posted);
  await deps.runs.recordFiles(runId, report.reviewedFiles);
  // A failed batch's files have no record at this head, so the next run reviews them however
  // far the incremental range has moved on.
  await deps.runs.succeedRun(runId, {
    filesDone: report.plan.reviewed,
    costUsd: costOf(report),
    reviewedSha: pr.headSha,
    statusLabel: decision.label ?? run.statusLabel,
    summaryCommentId: comment.id ?? run.summaryCommentId,
    review: posted,
  });
  deps.log("posted", {
    runId,
    event: decision.event,
    complete: report.complete,
    reviewed: !quiet,
    outdated: outdated.length,
    reopened: reopened.length,
  });
  return {
    runId,
    event: decision.event,
    complete: report.complete,
    findings: fresh,
    reviewed: !quiet,
  };
}
