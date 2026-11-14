import { statusLabels } from "@lgtmoose/config";
import type { Finding, ReviewEvent } from "@lgtmoose/core";
import {
  changedPaths,
  diffCommits,
  pathsOf,
  pool,
  rawDiff,
  trackLines,
  type ChangedPath,
  type LineRef,
  type RawDiff,
  type Repo,
} from "@lgtmoose/git";
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
 * A finding to follow: one of our records, with its status when it's one `standing` may move
 * (open or outdated). Closed ones (resolved or declined by a person) have none.
 */
type TrackedRecord = Omit<FindingRecord, "status"> & { status?: FindingRecord["status"] };

/**
 * The findings to follow to the new head: those `followAll` picks, and the rest only while the
 * PR still changes their file, under its name at head (`nameAtHead`: it may have been renamed
 * since). Findings on files the PR left alone stay as they are, which keeps the work from
 * growing with the PR's age.
 */
function toTrack<T extends TrackedRecord>(
  records: readonly T[],
  changes: readonly ChangedPath[],
  followAll: (record: T) => boolean,
  nameAtHead: (path: string) => string,
): T[] {
  const { changed, atHead } = prPaths(changes);
  return records.filter(
    (record) =>
      followAll(record) ||
      (record.side === "RIGHT" ? atHead : changed).has(nameAtHead(record.path)),
  );
}

/**
 * What following findings needs to know about their commits and files' names, read once: which
 * commits are here, the base each old-side finding's commit had, every name a file has had
 * mapped to its name at head, each such base's names, and each commit's file list to head (for
 * `trackLines` to reuse).
 */
interface History {
  present: ReadonlySet<string>;
  /** Each old-side finding's commit's merge base with today's; "" without shared history. */
  raisedBase: ReadonlyMap<string, string>;
  nameAtHead: (path: string) => string;
  /** For each such base, a merge-base name's name at that base. */
  nameAtBase: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Each present commit's file list to head. */
  since: ReadonlyMap<string, RawDiff>;
}

/**
 * Names from the PR's diff alone (merge base to head): each file's head name under its own and
 * its base-side name. Enough to tell which findings need their commits' history to be placed.
 * A path the PR deletes isn't placed: against the merge base, a file rewritten and then renamed
 * shows as deleted plus added, though it's a rename since the finding's commit. Its history says
 * where it went, or that it's gone.
 */
function prNames(changes: readonly ChangedPath[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of changes) if (file.status !== "deleted") names.set(file.path, file.path);
  for (const file of changes) {
    if (file.oldPath !== undefined && file.status !== "deleted" && !names.has(file.oldPath)) {
      names.set(file.oldPath, file.path);
    }
  }
  return names;
}

/**
 * Reads `records`' history: whether their commits are here, the base each old-side one's commit
 * had, and every name their files have had. The names come from the PR's renames (merge base to
 * head), the PR's renames since each finding's commit (that commit to head: one file list per
 * commit, reused to follow its lines), and the base's renames since each such base (that base to
 * today's merge base).
 */
async function readHistory(
  repo: Repo,
  records: readonly TrackedRecord[],
  changes: readonly ChangedPath[],
  mergeBase: string,
  headSha: string,
): Promise<History> {
  const names = prNames(changes);
  const nameAtHead = (path: string) => names.get(path) ?? path;
  const learn = (from: string, to: string) => {
    if (!names.has(from)) names.set(from, to);
  };
  const fromBase = new Map(changes.map((file) => [file.oldPath ?? file.path, file.path]));

  // One check for every commit the findings were raised at.
  const present = await repo.hasCommits(records.map((record) => record.raisedAtSha));
  const followable = records.filter((record) => present.has(record.raisedAtSha));
  const raisedShas = [...new Set(followable.map((record) => record.raisedAtSha))];
  const sinceList = await pool(raisedShas, FOLLOW_AT_ONCE, (sha) => rawDiff(repo, sha, headSha));
  const since = new Map(raisedShas.map((sha, i) => [sha, sinceList[i] as RawDiff]));
  for (const raw of sinceList) {
    for (const file of pathsOf(raw)) {
      if (file.oldPath !== undefined && file.status !== "deleted") {
        learn(file.oldPath, nameAtHead(file.path));
      }
    }
  }
  // The base each old-side finding's commit had: its merge base with today's.
  const leftShas = [
    ...new Set(followable.filter((r) => r.side === "LEFT").map((r) => r.raisedAtSha)),
  ];
  const leftBases = await pool(leftShas, FOLLOW_AT_ONCE, async (sha) =>
    // No common history: exit 1, no output.
    (await repo.git(["merge-base", sha, mergeBase], { okExitCodes: [1] })).trim(),
  );
  const raisedBase = new Map(leftShas.map((sha, i) => [sha, leftBases[i] ?? ""]));
  const bases = [...new Set([...raisedBase.values()].filter((base) => base !== ""))];
  const baseMoves = await pool(bases, FOLLOW_AT_ONCE, (base) =>
    changedPaths(repo, base, mergeBase),
  );
  const nameAtBase = new Map<string, Map<string, string>>();
  for (const [i, base] of bases.entries()) {
    const earlier = new Map<string, string>();
    for (const file of baseMoves[i] ?? []) {
      if (file.oldPath === undefined || file.status === "deleted") continue;
      earlier.set(file.path, file.oldPath);
      learn(file.oldPath, fromBase.get(file.path) ?? file.path);
    }
    nameAtBase.set(base, earlier);
  }
  return { present, raisedBase, nameAtHead, nameAtBase, since };
}

/** Which of `paths` are files at `headSha` (one tree read). */
async function pathsAtHead(
  repo: Repo,
  headSha: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(paths)];
  if (wanted.length === 0) return new Set();
  const out = await repo.git([
    "ls-tree",
    "-z",
    "--name-only",
    headSha,
    "--",
    ...wanted.map((path) => `:(literal)${path}`),
  ]);
  return new Set(out.split("\0").filter((path) => path !== ""));
}

/** Paths the PR changes (deleting included), and those of them still there at head. */
function prPaths(changes: readonly ChangedPath[]): { changed: Set<string>; atHead: Set<string> } {
  return {
    changed: new Set(changes.map((file) => file.path)),
    atHead: new Set(changes.flatMap((file) => (file.status === "deleted" ? [] : [file.path]))),
  };
}

/**
 * One of our recorded findings as an earlier finding at `place` (its recorded one by default),
 * `followed` there from the commit it was raised at, or not.
 */
function recordToEarlier(
  record: TrackedRecord,
  place: LineRef = { path: record.path, line: record.line },
  followed = true,
): EarlierFinding {
  const shift = place.line - record.line;
  const startLine = record.startLine === undefined ? undefined : record.startLine + shift;
  return {
    finding: {
      rule_category: record.ruleCategory,
      severity: record.severity,
      path: place.path,
      line: place.line,
      side: record.side,
      ...(startLine === undefined || startLine < 1 ? {} : { start_line: startLine }),
      title: record.title,
      body: record.body,
      // Not kept: earlier findings are only counted, listed and matched, never posted again.
      evidence: record.title,
    },
    fingerprint: record.fingerprint,
    ...(record.githubCommentId === undefined ? {} : { commentId: record.githubCommentId }),
    ...(followed ? {} : { followed: false }),
  };
}

/** How many commits' lines are followed at once. */
const FOLLOW_AT_ONCE = 4;

/**
 * Splits the PR's tracked findings into those standing at `headSha`, moved to where their lines
 * are now, and those whose lines don't exist there (changed, deleted, or the PR no longer
 * changes the file). Open findings that no longer stand are `outdated`; outdated ones that stand
 * again, such as after a fix is reverted, are `reopened`.
 *
 * A finding on the old side is on a line the PR deletes. It's followed from the base the PR had
 * when it was raised (its merge base with today's) to today's merge base, and stands while the
 * PR still deletes that line. When the commit a finding was raised at is gone (force-pushed
 * away), its lines can't be followed: one `keepInPlace` picks stands at its old place while the
 * PR still changes the file; the others don't stand. Only open ones go `outdated` and only
 * outdated ones are `reopened`; a record with no status (a closed one) just stands or not.
 */
async function standing(
  repo: Repo,
  records: readonly TrackedRecord[],
  changes: readonly ChangedPath[],
  mergeBase: string,
  headSha: string,
  keepInPlace: (record: TrackedRecord) => boolean,
  history: History,
): Promise<{ open: (EarlierFinding & { id: string })[]; outdated: string[]; reopened: string[] }> {
  if (records.length === 0) return { open: [], outdated: [], reopened: [] };
  const { atHead } = prPaths(changes);
  // The PR's diff: each file's name at head, and at today's merge base (they differ for renames).
  const baseSide = new Map(changes.map((file) => [file.path, file.oldPath ?? file.path]));
  const fromBase = new Map(changes.map((file) => [file.oldPath ?? file.path, file.path]));
  const refs = (list: readonly TrackedRecord[], path: (record: TrackedRecord) => string) =>
    list.map((record) => ({ path: path(record), line: record.line }));

  const { present, raisedBase, nameAtHead, nameAtBase, since } = history;
  const followable = records.filter((record) => present.has(record.raisedAtSha));

  // Where each finding is now. Undefined: its line is gone. Not in the map: it can't be
  // followed (the commit it was raised at is gone, or shares no history with the base).
  const at = new Map<TrackedRecord, LineRef | undefined>();
  // New-side lines: from the head they were raised at to this head (renames followed).
  const right = followable.filter((record) => record.side === "RIGHT");
  await pool(
    [...Map.groupBy(right, (record) => record.raisedAtSha)],
    FOLLOW_AT_ONCE,
    async ([sha, group]) => {
      const moved = await trackLines(
        repo,
        sha,
        headSha,
        refs(group, (record) => record.path),
        since.get(sha),
      );
      for (const [i, record] of group.entries()) at.set(record, moved[i]);
    },
  );
  // Old-side lines: from the base the PR had when they were raised to today's merge base, by
  // their name at that base; one diff per such base. They stand while the PR still deletes
  // that line, so only the patches of the files they end up in are read.
  const left = followable.filter(
    (record) => record.side === "LEFT" && raisedBase.get(record.raisedAtSha) !== "",
  );
  const leftPlaces = new Map<TrackedRecord, LineRef | undefined>();
  await pool(
    [...Map.groupBy(left, (record) => raisedBase.get(record.raisedAtSha) ?? "")],
    FOLLOW_AT_ONCE,
    async ([base, group]) => {
      const atBase = (record: TrackedRecord) => {
        const head = nameAtHead(record.path);
        const merged = baseSide.get(head) ?? head;
        return nameAtBase.get(base)?.get(merged) ?? merged;
      };
      const moved = await trackLines(repo, base, mergeBase, refs(group, atBase));
      for (const [i, record] of group.entries()) leftPlaces.set(record, moved[i]);
    },
  );
  const leftPaths = [...leftPlaces.values()].flatMap((place) =>
    place === undefined ? [] : [place.path, fromBase.get(place.path) ?? place.path],
  );
  const patches =
    leftPaths.length === 0
      ? []
      : await diffCommits(repo, mergeBase, headSha, { paths: [...new Set(leftPaths)] });
  const deletedLines = new Map(
    patches.map((file) => [
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
  for (const [record, place] of leftPlaces) {
    // Stands only while the PR still deletes that line, under the file's name at head.
    const deleted = place !== undefined && deletedLines.get(place.path)?.has(place.line);
    at.set(
      record,
      deleted === true
        ? { path: fromBase.get(place.path) ?? place.path, line: place.line }
        : undefined,
    );
  }

  const open: (EarlierFinding & { id: string })[] = [];
  const outdated: string[] = [];
  const reopened: string[] = [];
  for (const record of records) {
    const isLeft = record.side === "LEFT";
    let place: LineRef | undefined;
    if (at.has(record)) {
      place = at.get(record);
      if (place !== undefined && !isLeft && !atHead.has(place.path)) place = undefined;
    } else {
      // Not followable: one kept in place keeps its line, under the file's name at head, while
      // the PR changes the file.
      const head = nameAtHead(record.path);
      const inPr = isLeft ? baseSide.has(head) : atHead.has(head);
      place = keepInPlace(record) && inPr ? { path: head, line: record.line } : undefined;
    }
    if (place === undefined) {
      if (record.status === "open") outdated.push(record.id);
      continue;
    }
    if (record.status === "outdated") reopened.push(record.id);
    // Followed to its place now, or kept at its recorded one (its commit is gone, its file still
    // in the PR): either way, that's where it is.
    open.push({ ...recordToEarlier(record, place), id: record.id });
  }
  return { open, outdated, reopened };
}

function withoutId({ id: _id, ...entry }: EarlierFinding & { id: string }): EarlierFinding {
  return entry;
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
  // What people did to our comments' threads first: a resolved one takes its finding out of the
  // decision, and one unresolved again puts it back. If the threads can't be read, findings
  // stay as they are.
  try {
    const threads = await github.threads.reviewThreads(target);
    const synced = await deps.findings.syncThreads(run.pullRequestId, threads, pr.headSha);
    if (synced.resolved + synced.unresolved > 0) deps.log("review threads", { runId, ...synced });
  } catch (error) {
    deps.log("review threads unread", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    // Findings a person resolved or declined: followed to this head like the others (renames
    // included), so a re-raise is matched at their place now. Those whose line is gone or can't
    // be followed are matched by fingerprint and comment ID only.
    const closedRecords = await deps.findings.closedFindings(run.pullRequestId);
    const closedIds = new Set(closedRecords.map((record) => record.id));
    let closed: EarlierFinding[] = closedRecords.map((record) =>
      recordToEarlier(record, undefined, false),
    );
    if (records.length + closedRecords.length > 0) {
      // Which files the PR changes: names only, no patches or contents.
      const changes = await changedPaths(repo, prepared.mergeBase, pr.headSha);
      // Open ones are always followed; outdated and closed ones only while the PR still changes
      // their file, under its name at head. Open and closed ones are kept at their recorded
      // place when their commit is gone; closed ones are never marked outdated or reopened.
      const followAll = (record: TrackedRecord) => record.status === "open";
      const candidates: TrackedRecord[] = [...records, ...closedRecords];
      // The PR's own renames tell most findings' files apart. One whose recorded file is neither
      // in the PR under some name nor at head under that name was renamed (by the PR since, or
      // by the base) or is gone: its commit's history says which.
      const known = prNames(changes);
      const unplaced = candidates.filter((record) => !known.has(record.path));
      const atHead = await pathsAtHead(
        repo,
        pr.headSha,
        unplaced.map((record) => record.path),
      );
      const needHistory = unplaced.filter((record) => !atHead.has(record.path));
      const byName = toTrack(candidates, changes, followAll, (path) => known.get(path) ?? path);
      const read = [...new Set([...byName, ...needHistory])];
      // The commits those findings were raised at: one request.
      await repo.fetchCommits(read.map((record) => record.raisedAtSha));
      const history = await readHistory(repo, read, changes, prepared.mergeBase, pr.headSha);
      const tracked = toTrack(read, changes, followAll, history.nameAtHead);
      const all = await standing(
        repo,
        tracked,
        changes,
        prepared.mergeBase,
        pr.headSha,
        (record) => record.status === "open" || closedIds.has(record.id),
        history,
      );
      const followed = new Map(
        all.open.filter((entry) => closedIds.has(entry.id)).map((entry) => [entry.id, entry]),
      );
      closed = closedRecords.map((record, i) => {
        const entry = followed.get(record.id);
        return entry === undefined ? (closed[i] as EarlierFinding) : withoutId(entry);
      });
      earlier = {
        open: all.open.filter((entry) => !closedIds.has(entry.id)),
        outdated: all.outdated,
        reopened: all.reopened,
      };
    }
    ({ outdated, reopened } = earlier);
    const latest = await github.reader.pull(target);
    report = await finishReview(repo, prepared, outcomes, latest.headSha, {
      earlier: earlier.open.map(withoutId),
      closed,
      stored: records.map((record) => ({
        fingerprint: record.fingerprint,
        severity: record.severity,
      })),
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
  // Each inline finding's comment on GitHub, to follow its review thread.
  const commentIds = new Map<Finding, number>();
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
    for (const [i, finding] of review.payload.commented.entries()) {
      const id = review.commentIds[i];
      if (id !== undefined) commentIds.set(finding, id);
    }
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
  // Raised again more severely: stored at the higher severity, as the decision counted it.
  const escalated = new Map(report.escalated.map((entry) => [entry.fingerprint, entry.severity]));
  await deps.findings.escalate(
    records.flatMap((record) => {
      const severity = escalated.get(record.fingerprint);
      return severity === undefined ? [] : [{ id: record.id, severity }];
    }),
    pr.headSha,
  );
  await deps.findings.saveFindings(
    run.pullRequestId,
    runId,
    pr.headSha,
    report.posted.map((entry) => {
      const id = commentIds.get(entry.finding);
      return id === undefined ? entry : { ...entry, githubCommentId: id };
    }),
  );
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
    escalated: report.escalated.length,
  });
  return {
    runId,
    event: decision.event,
    complete: report.complete,
    findings: fresh,
    reviewed: !quiet,
  };
}
