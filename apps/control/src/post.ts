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
  const { atHead } = prPaths(prFiles);
  // Old-side lines are keyed by the file's path on the base side, which differs for renames.
  const baseSide = new Map(prFiles.map((file) => [file.path, file.oldPath ?? file.path]));
  const deletedLines = new Map(
    prFiles.map((file) => [
      file.oldPath ?? file.path,
      new Set(
        file.hunks.flatMap((hunk) =>
          hunk.lines.flatMap((line) =>
            line.kind === "del" && line.oldLine !== undefined ? [line.oldLine] : [],
          ),
        ),
      ),
    ]),
  );
  const refs = (list: readonly FindingRecord[], path: (record: FindingRecord) => string) =>
    list.map((record) => ({ path: path(record), line: record.line }));
  const groupBy = <K>(list: readonly FindingRecord[], key: (record: FindingRecord) => K) => {
    const groups = new Map<K, FindingRecord[]>();
    for (const record of list) {
      const group = groups.get(key(record));
      if (group === undefined) groups.set(key(record), [record]);
      else group.push(record);
    }
    return groups;
  };

  // Where each finding is now. Undefined: its line is gone. Not in the map: it can't be
  // followed (the commit it was raised at is gone, or shares no history with the base).
  const at = new Map<FindingRecord, LineRef | undefined>();
  // One check for every commit the findings were raised at.
  const present = await repo.hasCommits(records.map((record) => record.raisedAtSha));
  // New-side lines: from the head they were raised at to this head.
  const right = records.filter((r) => r.side === "RIGHT" && present.has(r.raisedAtSha));
  for (const [sha, group] of groupBy(right, (record) => record.raisedAtSha)) {
    const moved = await trackLines(
      repo,
      sha,
      headSha,
      refs(group, (record) => record.path),
    );
    for (const [i, record] of group.entries()) at.set(record, moved[i]);
  }
  // Old-side lines: from the base the PR had when they were raised (its merge base with
  // today's) to today's merge base, by their base-side path; one diff per such base.
  const left = records.filter((r) => r.side === "LEFT" && present.has(r.raisedAtSha));
  const raisedBases = new Map<string, string>();
  for (const sha of new Set(left.map((record) => record.raisedAtSha))) {
    // No common history: exit 1, no output.
    const base = (await repo.git(["merge-base", sha, mergeBase], { okExitCodes: [1] })).trim();
    if (base !== "") raisedBases.set(sha, base);
  }
  const leftFollowed = left.filter((record) => raisedBases.has(record.raisedAtSha));
  for (const [base, group] of groupBy(leftFollowed, (r) => raisedBases.get(r.raisedAtSha))) {
    if (base === undefined) continue;
    const basePath = (record: FindingRecord) => baseSide.get(record.path) ?? record.path;
    const moved = await trackLines(repo, base, mergeBase, refs(group, basePath));
    for (const [i, record] of group.entries()) {
      const place = moved[i];
      // Stands only while the PR still deletes that line.
      const deleted = place !== undefined && deletedLines.get(place.path)?.has(place.line);
      at.set(record, deleted === true ? { path: record.path, line: place.line } : undefined);
    }
  }

  const open: EarlierFinding[] = [];
  const outdated: string[] = [];
  const reopened: string[] = [];
  for (const record of records) {
    const isLeft = record.side === "LEFT";
    let place: LineRef | undefined;
    if (at.has(record)) {
      place = at.get(record);
      if (place !== undefined && !isLeft && !atHead.has(place.path)) place = undefined;
    } else {
      // Not followable: an open finding keeps its place while its file is in the PR.
      const inPr = isLeft ? baseSide.has(record.path) : atHead.has(record.path);
      place =
        record.status === "open" && inPr ? { path: record.path, line: record.line } : undefined;
    }
    if (place === undefined) {
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
  return { open, outdated, reopened };
}

/**
 * Whether the approval we posted last still stands for this head: GitHub still has it as
 * APPROVED (it can be dismissed without a push) and it was submitted on this very commit, so a
 * repo that wants the latest push approved has it. Without a review ID (shadow mode) or a way
 * to read it, only a run at the same head counts; a failed read counts as not standing.
 */
async function approvalStands(
  reader: PullReader,
  target: PullTarget,
  run: RunRecord,
  headSha: string,
): Promise<boolean> {
  if (run.lastReviewEvent !== "APPROVE") return false;
  if (run.lastReviewId === undefined || reader.review === undefined) {
    return run.lastReviewedSha === headSha;
  }
  try {
    const review = await reader.review(target, run.lastReviewId);
    return review.state === "APPROVED" && review.commitId === headSha;
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
    let earlier: Awaited<ReturnType<typeof standing>> = { open: [], outdated: [], reopened: [] };
    if (records.length > 0) {
      const prFiles = await diffCommits(repo, prepared.mergeBase, pr.headSha);
      const tracked = toTrack(records, prFiles);
      // The commits those findings were raised at, to follow their lines: one request.
      await repo.fetchCommits(tracked.map((record) => record.raisedAtSha));
      earlier = await standing(repo, tracked, prFiles, prepared.mergeBase, pr.headSha);
    }
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
