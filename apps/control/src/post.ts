import { randomUUID } from "node:crypto";
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
  headKeys,
  otherReviewerFindings,
  runKeys,
  type BatchOutcome,
  type EarlierFinding,
  type PullReader,
  type PullTarget,
  type ReviewReport,
} from "@lgtmoose/pipeline";
import {
  GitHubError,
  annotationsFor,
  buildReview,
  type MarkedReview,
  type PullRef,
} from "@lgtmoose/poster";
import { syncStatusLabel } from "@lgtmoose/summary";
import { z } from "zod";
import { TASK_MISSING } from "./ecs.js";
import { readOutcome } from "./outcomes.js";
import type { ControlDeps, FindingRecord, RunRecord } from "./ports.js";
import { readManifest } from "./prepare.js";

/** What the post step did, for the log and the state machine. */
export interface PostOutput {
  runId: string;
  /**
   * False when the run stopped counting before it posted: its execution was stopped, the PR's
   * head moved on or the PR closed. Nothing was posted or recorded then.
   */
  posted: boolean;
  /**
   * The marker of another run's review that already covers this head, when this run posted
   * nothing because of it. Then it wrote nothing to the PR, and left the PR's record alone.
   */
  coveredBy?: string;
  event: ReviewEvent;
  complete: boolean;
  /** New findings this run posted. */
  findings: number;
  /**
   * False when no review was posted for the run's decision: an incremental run found nothing
   * new and the review on the PR already has this run's event and label (for an approval, one
   * that still stands), or another run's review covers the head.
   */
  reviewed: boolean;
}

const CHECK_TITLE: Record<ReviewEvent, string> = {
  APPROVE: "No changes needed",
  COMMENT: "Reviewed, not approved",
  REQUEST_CHANGES: "Changes requested",
};

function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/** What the post step has posted for a run, so far. */
interface PostProgress {
  /** Set when another run's review covered the head, so this run posted nothing. */
  coveredBy?: string;
  /** The attempt that saved it, and how many saves it has made: no two writers' match. */
  attempt?: string;
  writes?: number;
  review?: boolean;
  checkRun?: boolean;
  summary?: boolean;
  summaryCommentId?: number;
  label?: boolean;
  /** What it wrote to the PR, so a run its review covers can bring the PR up to it. */
  summaryBody?: string;
  labelTarget?: string;
  /** The label its decision calls for, saved before its first write to GitHub. */
  decisionLabel?: string;
  /** How many annotations its check run is to have, saved before creating it. */
  checkRunAnnotations?: number;
  /** The review it posted, by GitHub ID (none in shadow mode). */
  reviewId?: number;
  /** It posted no review: GitHub's already says what its decision does (see `post`). */
  quiet?: boolean;
  /** Its findings are recorded: outdated, reopened, escalated and new ones. */
  findings?: boolean;
}

const postProgressSchema = z.object({
  coveredBy: z.string().optional(),
  attempt: z.string().optional(),
  writes: z.number().int().nonnegative().optional(),
  review: z.boolean().optional(),
  checkRun: z.boolean().optional(),
  summary: z.boolean().optional(),
  summaryCommentId: z.number().int().positive().optional(),
  label: z.boolean().optional(),
  summaryBody: z.string().optional(),
  labelTarget: z.string().optional(),
  /** The label its decision calls for, saved before its first write to GitHub. */
  decisionLabel: z.string().optional(),
  checkRunAnnotations: z.number().int().nonnegative().optional(),
  reviewId: z.number().int().positive().optional(),
  quiet: z.boolean().optional(),
  findings: z.boolean().optional(),
});

/**
 * Another run's saved progress, read for what it wrote. Missing (it expires) or unreadable,
 * what it wrote is unknown: undefined.
 */
function readTheirs(text: string | undefined): PostProgress | undefined {
  try {
    return text === undefined ? undefined : readProgress(text);
  } catch {
    return undefined;
  }
}

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

/** How every run's review marker starts. */
export const REVIEW_MARKER_PREFIX = "lgtmoose-run:";

/**
 * The hidden marker in a run's review, by which a later post finds it on GitHub: the run, and
 * whether the review covered the whole PR (an incomplete one, after failed batches, mustn't
 * keep a complete one from being posted).
 */
export function reviewMarker(runId: string, complete: boolean): string {
  return `${REVIEW_MARKER_PREFIX}${runId}:${complete ? "complete" : "incomplete"}`;
}

/**
 * Our reviews on the head that could make another from this run moot, the complete ones
 * first. One does once its run has finished the head (see `post`): a complete review, or an
 * incomplete one when this run is incomplete too. A complete run posts over an incomplete
 * review, whatever it decided: the incomplete run's posted findings are recorded, and count in
 * this run's decision as earlier findings, so it can't approve past their blocking ones.
 */
export function coveringReviews(
  reviews: readonly MarkedReview[],
  complete: boolean,
): MarkedReview[] {
  const done = reviews.filter((review) => review.marker.endsWith(":complete"));
  const incomplete = reviews.filter((review) => review.marker.endsWith(":incomplete"));
  return [...done, ...(complete ? [] : incomplete)];
}

/** `read`, called the first time only: its promise is shared by every later call. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= read());
}

/** `read` per key, called once for each key. */
function memo<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const results = new Map<string, Promise<T>>();
  return (key) => {
    let result = results.get(key);
    if (result === undefined) {
      result = read(key);
      results.set(key, result);
    }
    return result;
  };
}

/** The run a review marker names. */
export function markerRun(marker: string): string {
  return marker.slice(REVIEW_MARKER_PREFIX.length).split(":")[0] ?? "";
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
  /**
   * Another execution's status (RUNNING, SUCCEEDED…), undefined when it doesn't exist: whether
   * a covering run may still be retried.
   */
  executionStatus?: (executionArn: string) => Promise<string | undefined>;
}

const claimSchema = z.object({
  attempt: z.string(),
  /** The run the attempt is for: the head's claim can be held by another run. */
  runId: z.string().optional(),
  taskArn: z.string().optional(),
  claimedAt: z.number().optional(),
});

/**
 * How long a claim held off ECS counts. Its holder can't be checked, so past the post step's
 * longest run (its 30-minute task timeout) it's taken to have ended.
 */
export const OFF_ECS_CLAIM_TTL_MS = 30 * 60_000;

/**
 * A claim's holder is done with it: its containers have stopped (DEPROVISIONING comes after
 * STOPPING, as the task's network is torn down), the task has stopped or been deleted, or ECS
 * no longer knows it. A task still DEACTIVATING or STOPPING may yet be running its process.
 */
const HOLDER_GONE = new Set(["DEPROVISIONING", "STOPPED", "DELETED", TASK_MISSING]);

/** The summary comment's hidden marker: one per PR, so any run finds the PR's comment. */
export const SUMMARY_MARKER = "lgtmoose-summary";

/**
 * Takes a claim for this attempt. The run's claim is held before the post writes anything to
 * GitHub, so two attempts (a retry and the attempt it replaced, still alive) never write at
 * once: only the holder posts the review, sends check-run annotations, or saves progress. The
 * head's claim is held around checking the head for our review and submitting one, so two
 * runs at one head take turns there. The claim names the attempt's ECS task. Returns the
 * claim's ETag. When another attempt holds it:
 * - its task has stopped (or is gone): the claim is taken over, with a write conditional on
 *   the claim being unchanged, so two attempts can't both take it over;
 * - its task is still running, or can't be told: the step fails, and its retry tries later.
 * Our own write that S3 applied but answered 412 to the SDK's retry counts as ours (see
 * `conditionalPut`): the claim's body names this attempt.
 */
async function holdClaim(
  deps: ControlDeps,
  options: { attempt: PostAttempt; taskStatus: (taskArn: string) => Promise<string> },
  claimKey: string,
  runId: string,
  what = "this run's post",
): Promise<{ etag: string; tookOver: boolean }> {
  const mine = JSON.stringify({
    attempt: options.attempt.id,
    runId,
    ...(options.attempt.taskArn === undefined
      ? { claimedAt: Date.now() }
      : { taskArn: options.attempt.taskArn }),
  });
  const created = await deps.store.createText(claimKey, mine);
  if (created !== undefined) return { etag: created, tookOver: false };
  const current = await deps.store.getTagged(claimKey);
  // Released since: claim it afresh, once.
  if (current === undefined) {
    const again = await deps.store.createText(claimKey, mine);
    if (again !== undefined) return { etag: again, tookOver: false };
    throw new Error(`Another attempt claimed ${what} just now.`);
  }
  const holder = claimSchema.safeParse(parseJson(current.text));
  const holderTask = holder.success ? holder.data.taskArn : undefined;
  // A holder off ECS can't be checked. An earlier attempt of this same run, when this one is
  // off ECS too (a local or dev run, with no parallel retries), has ended: take it over at
  // once. Anyone else waits until the claim expires; one with no time on it never does.
  if (holder.success && holderTask === undefined) {
    const sameRunOffEcs = options.attempt.taskArn === undefined && holder.data.runId === runId;
    const claimedAt = holder.data.claimedAt;
    const expired = claimedAt !== undefined && Date.now() - claimedAt >= OFF_ECS_CLAIM_TTL_MS;
    if (!sameRunOffEcs && !expired) {
      throw new Error(`Another attempt, off ECS, holds the claim on ${what}.`);
    }
  }
  // An unreadable claim has no holder to wait for.
  if (holderTask !== undefined) {
    const status = await options.taskStatus(holderTask);
    if (!HOLDER_GONE.has(status)) {
      throw new Error(`Another attempt (task ${status}) holds the claim on ${what}.`);
    }
  }
  const taken = await deps.store.replaceText(claimKey, mine, current.etag);
  if (taken === undefined) throw new Error(`Another attempt took over the claim on ${what}.`);
  deps.log("took over a stopped attempt's claim", { claimKey, holderTask });
  return { etag: taken, tookOver: true };
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
 * A finding to follow: one of our records, with its status when it's one `standing` may move
 * (open or outdated). Closed ones (resolved or declined by a person) have none.
 */
type TrackedRecord = Omit<FindingRecord, "status"> & { status?: FindingRecord["status"] };

/** A file's names now: at head, for new-side findings; at today's merge base, for old-side ones. */
interface Names {
  nameAtHead: (path: string) => string;
  /**
   * An old-side finding's file at today's merge base: its recorded base-side name, followed
   * through the base's renames since the base its commit had, when that's known. Rows recorded
   * without a base-side name go through their head name.
   */
  baseNow: (record: TrackedRecord) => string;
}

/**
 * The findings to follow to the new head: those `followAll` picks, and the rest only while the
 * PR still changes their file: a new-side one's file at head (`names.nameAtHead`), an old-side
 * one's base file (`names.baseNow`). Findings on files the PR left alone stay as they are,
 * which keeps the work from growing with the PR's age.
 */
function toTrack<T extends TrackedRecord>(
  records: readonly T[],
  { atHead, changedBase }: PrPaths,
  followAll: (record: T) => boolean,
  names: Names,
): T[] {
  return records.filter(
    (record) =>
      followAll(record) ||
      (record.side === "RIGHT"
        ? atHead.has(names.nameAtHead(record.path))
        : changedBase.has(names.baseNow(record))),
  );
}

/**
 * What following findings needs to know about their commits and files' names, read once: which
 * commits are here, the base each old-side finding's commit had, the names files have now (two
 * maps, never mixed: head names for new-side findings, merge-base names for old-side ones, so an
 * old-side finding's base file never takes a name only head has), each such base's names, and
 * each commit's file list to head (for `trackLines` to reuse).
 */
interface History extends Names {
  present: ReadonlySet<string>;
  /** Each old-side finding's commit's merge base with today's; "" without shared history. */
  raisedBase: ReadonlyMap<string, string>;
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
  // New-side names only: what each file is called at head.
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
 * Old-side names from the PR's diff alone: a base-side file's name at today's merge base, under
 * its name at head (a rename the PR makes) and its own. Paths the PR adds aren't base files.
 */
function prBaseNames(changes: readonly ChangedPath[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of changes) {
    if (file.status !== "added") names.set(file.path, file.oldPath ?? file.path);
  }
  for (const file of changes) {
    if (file.oldPath !== undefined && !names.has(file.oldPath)) {
      names.set(file.oldPath, file.oldPath);
    }
  }
  return names;
}

/** The PR's diff alone, as `Names`: before any history is read. */
function prOnlyNames(changes: readonly ChangedPath[]): Names {
  const head = prNames(changes);
  const base = prBaseNames(changes);
  return {
    nameAtHead: (path) => head.get(path) ?? path,
    baseNow: (record) => record.basePath ?? base.get(record.path) ?? record.path,
  };
}

/**
 * Reads `records`' history: whether their commits are here, the base each old-side one's commit
 * had, and the names their files have now. Head names come from the PR's renames (merge base to
 * head) and its renames since each finding's commit (that commit to head: one file list per
 * commit, reused to follow its lines). Merge-base names come from the PR's diff and the base's
 * renames since each such base (that base to today's merge base).
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
  // For rows recorded without a base-side name: the PR's base-side names, with the base's
  // renames learned below.
  const baseNames = prBaseNames(changes);
  const nameAtMergeBase = (path: string) => baseNames.get(path) ?? path;
  // For each finding's base, a name there's name at today's merge base.
  const movedSince = new Map<string, Map<string, string>>();

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
    const later = new Map<string, string>();
    for (const file of baseMoves[i] ?? []) {
      if (file.oldPath === undefined || file.status === "deleted") continue;
      earlier.set(file.path, file.oldPath);
      later.set(file.oldPath, file.path);
      if (!baseNames.has(file.oldPath)) baseNames.set(file.oldPath, file.path);
    }
    nameAtBase.set(base, earlier);
    movedSince.set(base, later);
  }
  // Its recorded base-side name, followed through the base's renames since the base it was
  // raised on. Without that base (its commit is gone, or shares no history), it can't be
  // followed anyway: as recorded.
  const baseNow = (record: TrackedRecord) => {
    if (record.basePath === undefined) return nameAtMergeBase(record.path);
    const base = raisedBase.get(record.raisedAtSha) ?? "";
    return movedSince.get(base)?.get(record.basePath) ?? record.basePath;
  };
  return { present, raisedBase, nameAtHead, baseNow, nameAtBase, since };
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

/**
 * The files the PR changes: those at head (not deleted), by head name, and those on the base side
 * (not added), by merge-base name.
 */
interface PrPaths {
  atHead: ReadonlySet<string>;
  changedBase: ReadonlySet<string>;
}

function prPaths(changes: readonly ChangedPath[]): PrPaths {
  return {
    atHead: new Set(changes.flatMap((file) => (file.status === "deleted" ? [] : [file.path]))),
    changedBase: new Set(
      changes.flatMap((file) => (file.status === "added" ? [] : [file.oldPath ?? file.path])),
    ),
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
 * away) or shares no history with the base, its lines can't be followed exactly, so it doesn't
 * stand: an open one goes outdated. Only open ones go `outdated` and only outdated ones are
 * `reopened`; a record with no status (a closed one) just stands or not.
 */
async function standing(
  repo: Repo,
  records: readonly TrackedRecord[],
  mergeBase: string,
  headSha: string,
  history: History,
  { atHead }: PrPaths,
  prDiff: RawDiff,
): Promise<{ open: (EarlierFinding & { id: string })[]; outdated: string[]; reopened: string[] }> {
  if (records.length === 0) return { open: [], outdated: [], reopened: [] };
  // A base-side file's name at head (a deleted one keeps its own).
  const fromBase = new Map(
    pathsOf(prDiff).flatMap((file) =>
      file.status === "added" ? [] : [[file.oldPath ?? file.path, file.path]],
    ),
  );
  const refs = (list: readonly TrackedRecord[], path: (record: TrackedRecord) => string) =>
    list.map((record) => ({ path: path(record), line: record.line }));

  const { present, raisedBase, baseNow, nameAtBase, since } = history;
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
      // Old-side names only: never a name only head has. Its recorded base-side name is its
      // name at that base; rows without one go back from today's.
      const atBase = (record: TrackedRecord) => {
        if (record.basePath !== undefined) return record.basePath;
        const merged = baseNow(record);
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
      : await diffCommits(repo, mergeBase, headSha, {
          paths: [...new Set(leftPaths)],
          raw: prDiff,
        });
  // The lines the PR deletes, by base file.
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
    // Not in `at`: it can't be followed exactly, so it doesn't stand.
    let place = at.get(record);
    if (place !== undefined && !isLeft && !atHead.has(place.path)) place = undefined;
    if (place === undefined) {
      if (record.status === "open") outdated.push(record.id);
      continue;
    }
    if (record.status === "outdated") reopened.push(record.id);
    // Followed to its place now.
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
 * A stopped execution's post task keeps running (it waits for a task token, so a stop can't
 * cut it short). So before its first write to GitHub it checks that the run still counts:
 * `running()` (its execution isn't stopped), and the PR still open at the run's head. If not,
 * it posts nothing and marks the run superseded. Once it has written anything it records what
 * it posted; `succeedRun` leaves the PR's record to a newer run that has already posted.
 *
 * Our findings from earlier runs that are still open count towards the decision; those whose
 * lines are gone are marked outdated, and outdated ones whose lines are back are reopened. An
 * incremental run that found nothing new, and whose decision is the review event and label
 * already on the PR (for an approval, one that still stands), posts no review, but still
 * updates the check run, the summary and the label, and records the head as reviewed.
 */
export async function post(
  deps: ControlDeps,
  runId: string,
  options: PostOptions = {},
): Promise<PostOutput> {
  const running = options.running ?? (async () => true);
  const attempt = options.attempt ?? { id: randomUUID(), taskArn: undefined };
  const taskStatus = options.taskStatus ?? (async () => TASK_MISSING);
  const executionStatus = options.executionStatus ?? (async () => undefined);
  const run = await deps.runs.getRun(runId);
  if (run === undefined) throw new Error(`No review run ${runId}.`);
  const keys = runKeys(runId);
  const preparedText = await deps.store.getText(keys.prepared);
  if (preparedText === undefined) throw new Error(`Run ${runId} has no prepared review.`);
  // Written by this run's own prepare step with the control task's role; still shape-checked.
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
  // Read once: also tells which of other reviewers' threads are resolved. Unread, other
  // reviewers' comments don't count (a resolved one can't be told apart).
  let threads: Awaited<ReturnType<typeof github.threads.reviewThreads>> | undefined;
  try {
    threads = await github.threads.reviewThreads(target);
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
  let latest: Awaited<ReturnType<typeof github.reader.pull>>;
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
      const prDiff = await rawDiff(repo, prepared.mergeBase, pr.headSha);
      const changes = pathsOf(prDiff);
      // Open ones are always followed; outdated and closed ones only while the PR still changes
      // their file (a new-side one's at head, an old-side one's base file). One whose commit is
      // gone can't be followed exactly and doesn't stand; closed ones are never marked outdated
      // or reopened.
      const followAll = (record: TrackedRecord) => record.status === "open";
      const candidates: TrackedRecord[] = [...records, ...closedRecords];
      // The PR's own renames tell most findings' files apart. One whose recorded file is neither
      // in the PR under some name nor at head under that name was renamed (by the PR since, or
      // by the base) or is gone: its commit's history says which.
      const paths = prPaths(changes);
      const { changedBase } = paths;
      const known = prNames(changes);
      const prOnly = prOnlyNames(changes);
      // The file a finding is on: at head for a new-side one, on the base side for an old-side.
      const fileOf = (record: TrackedRecord) =>
        record.side === "RIGHT" ? record.path : (record.basePath ?? record.path);
      const unplaced = candidates.filter((record) =>
        record.side === "RIGHT"
          ? !known.has(record.path)
          : !changedBase.has(prOnly.baseNow(record)),
      );
      const atHead = await pathsAtHead(repo, pr.headSha, unplaced.map(fileOf));
      const needHistory = unplaced.filter((record) => !atHead.has(fileOf(record)));
      const byName = toTrack(candidates, paths, followAll, prOnly);
      const read = [...new Set([...byName, ...needHistory])];
      // The commits those findings were raised at: one request.
      await repo.fetchCommits(read.map((record) => record.raisedAtSha));
      const history = await readHistory(repo, read, changes, prepared.mergeBase, pr.headSha);
      const tracked = toTrack(read, paths, followAll, history);
      const all = await standing(
        repo,
        tracked,
        prepared.mergeBase,
        pr.headSha,
        history,
        paths,
        prDiff,
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
    latest = await github.reader.pull(target);
    // Other reviewers' unresolved Critical, Major and bug comments on the files this review
    // covers: open findings of theirs, counted and listed, never posted. Their text is untrusted
    // and goes nowhere but the severity check.
    const others =
      threads === undefined
        ? []
        : otherReviewerFindings(prepared.comments, {
            paths: new Set(
              prepared.files.flatMap((file) => (file.status === "deleted" ? [] : [file.path])),
            ),
            resolved: new Set(
              threads.flatMap((thread) =>
                thread.resolved && thread.firstCommentId !== undefined
                  ? [thread.firstCommentId]
                  : [],
              ),
            ),
            ...(github.appId === undefined ? {} : { ourAppId: github.appId }),
            ourCommentIds: new Set(
              [...records, ...closedRecords].flatMap((record) =>
                record.githubCommentId === undefined ? [] : [record.githubCommentId],
              ),
            ),
          });
    report = await finishReview(repo, prepared, outcomes, latest.headSha, {
      earlier: earlier.open.map(withoutId),
      closed,
      stored: records.map((record) => ({
        fingerprint: record.fingerprint,
        severity: record.severity,
      })),
      others,
    });
    if (report.others > 0 || report.misses.length > 0) {
      deps.log("other reviewers' findings", {
        runId,
        counted: report.others,
        missed: report.misses.length,
      });
    }
  } finally {
    await work.remove();
  }

  // Two claims, both held before the first write to GitHub. The run's: attempts of this run
  // take turns, so only one writes or saves progress. The head's: runs at this head take turns
  // for the whole post (review, check run, summary, label and the record), so two runs at one
  // head never interleave; it's let go once the run is recorded. Progress is read once both are
  // held, so its version is the one this attempt saves over.
  const claim = await holdClaim(deps, { attempt, taskStatus }, keys.reviewClaim, runId);
  const headClaim = headKeys(
    `${target.owner}/${target.repo}`,
    target.number,
    pr.headSha,
  ).reviewClaim;
  const head = await holdClaim(deps, { attempt, taskStatus }, headClaim, runId, "this head's post");
  const releaseLogged = (key: string, etag: string) =>
    deps.store.deleteIfMatch(key, etag).catch((release: unknown) => {
      deps.log("releasing a claim failed", {
        runId,
        key,
        error: release instanceof Error ? release.message : String(release),
      });
    });
  const saved = await deps.store.getTagged(keys.posted);
  const progress = readProgress(saved?.text);
  // Each save is conditional on the version this attempt last wrote (or read), so two
  // overlapping attempts can't overwrite each other's progress: the second fails its step.
  let progressEtag = saved?.etag;
  const save = async () => {
    // Our attempt ID and a write count make the body ours alone, so a 412 answering the SDK's
    // retry of a write S3 applied is told from another attempt's write (see `conditionalPut`).
    progress.attempt = attempt.id;
    progress.writes = (progress.writes ?? 0) + 1;
    const body = JSON.stringify(progress);
    const etag =
      progressEtag === undefined
        ? await deps.store.createText(keys.posted, body)
        : await deps.store.replaceText(keys.posted, body, progressEtag);
    if (etag === undefined) {
      throw new Error("Another attempt saved this post's progress meanwhile.");
    }
    progressEtag = etag;
  };

  // Our reviews on the head, from any run: listed once per post.
  const headReviews = once(() => poster.markersAt(pull, pr.headSha, REVIEW_MARKER_PREFIX));
  const ownMarker = `${REVIEW_MARKER_PREFIX}${runId}:`;
  const ownReview = async () =>
    (await headReviews()).some((review) => review.marker.startsWith(ownMarker));

  // An earlier attempt may have posted this run's review and stopped before saving that. Then
  // it's posted, whatever has happened to the PR since: record it, never supersede.
  if (!progress.review && (await ownReview())) {
    progress.review = true;
    await save();
  }

  // Why the run no longer counts, if it doesn't. Marked superseded here, since the dispatcher
  // may never stop this execution (it may not have seen the event that made it stale).
  let stale: string | undefined;
  if (!progress.review) {
    stale = (await running()) ? staleReason(latest, pr.headSha) : "its execution was stopped";
  }
  if (stale !== undefined) {
    await deps.runs.supersedeRun(runId);
    await releaseLogged(headClaim, head.etag);
    deps.log("not posted", { runId, reason: stale });
    const findings = report.inline.length + report.body.length;
    return {
      runId,
      posted: false,
      event: report.decision.event,
      complete: false,
      findings,
      reviewed: false,
    };
  }

  const { decision } = report;
  const fresh = report.inline.length + report.body.length;
  // Nothing to say when the review on GitHub already says it: same event, same label, and for
  // an approval, one that still stands (a push can dismiss it as stale). Decided once: a retry
  // after the review was posted (or skipped) goes by what was done.
  const quiet = progress.review
    ? progress.quiet === true
    : report.kind === "incremental" &&
      fresh === 0 &&
      decision.label !== undefined &&
      decision.label === run.statusLabel &&
      decision.event === run.lastReviewEvent &&
      (decision.event !== "APPROVE" ||
        (await approvalStands(github.reader, target, run, pr.headSha)));
  // Each inline finding's comment on GitHub, to follow its review thread (this attempt's only).
  const commentIds = new Map<Finding, number>();
  const payload = buildReview({
    event: decision.event,
    inline: report.inline,
    outsideDiff: report.body,
    files: prepared.files,
    nitCap: config.gate.nit_cap,
    marker: reviewMarker(runId, report.complete),
  });
  const counts = { filesDone: report.plan.reviewed, costUsd: costOf(report) };
  const record = () =>
    deps.runs.succeedRun(runId, {
      ...counts,
      headSha: pr.headSha,
      // The label it set, or meant to: the reconciler re-syncs a label that didn't take. None
      // (the decision was skipped) leaves the recorded one as it is, like the label itself.
      statusLabel: decision.label,
      summaryCommentId: progress.summaryCommentId ?? run.summaryCommentId,
      // The review it posted; a quiet run leaves the PR's last review as it is.
      review: quiet ? undefined : { event: decision.event, id: progress.reviewId },
    });
  /**
   * Records the run's findings once its review is out (or skipped as quiet): outdated first (a
   * finding raised again at its new place, same fingerprint, is reopened), then reopened,
   * escalated and new ones, and the files it reviewed. Once per run: a retry skips it.
   */
  const recordFindings = async () => {
    if (progress.findings) return;
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
        const file = prepared.files.find((candidate) => candidate.path === entry.finding.path);
        const basePath = file === undefined ? undefined : (file.oldPath ?? file.path);
        return {
          ...entry,
          ...(id === undefined ? {} : { githubCommentId: id }),
          ...(basePath === undefined ? {} : { basePath }),
        };
      }),
    );
    // A failed batch's files have no record at this head, so the next run reviews them however
    // far the incremental range has moved on.
    await deps.runs.recordFiles(runId, report.reviewedFiles);
    // What other reviewers caught that we didn't, for the evals: no comment text.
    if (report.misses.length > 0) {
      await deps.store.putText(
        runKeys(runId).misses,
        `${JSON.stringify({ version: 1, runId, headSha: pr.headSha, misses: report.misses })}\n`,
      );
    }
    progress.findings = true;
    await save();
  };
  /** The summary comment, written (or found by its marker and edited) with `body`. */
  const writeSummary = async (body: string) => {
    const summaryId = progress.summaryCommentId ?? run.summaryCommentId;
    const comment = await poster.upsertSummaryComment(pull, body, summaryId, SUMMARY_MARKER);
    const id = comment.id ?? summaryId;
    if (id !== undefined) progress.summaryCommentId = id;
    progress.summary = true;
    progress.summaryBody = body;
    await save();
  };
  const writeLabel = async (target: string) => {
    const labels = await syncStatusLabel(poster.labels(pull), {
      target,
      statusLabels: statusLabels(config),
    });
    if (!labels.ok) deps.log("label sync", { runId, problem: labels.problem });
    progress.label = true;
    progress.labelTarget = target;
    await save();
  };
  /** The head's check run. This run holds the head, so it's this run's to write. */
  const annotations = annotationsFor([...report.inline, ...report.body]);
  /**
   * What a run this one's review covers needs from it, saved before the first write to GitHub:
   * the label its decision calls for, to set should this run not, and how many annotations its
   * check run is to have, to tell from GitHub's count that it was sent in full, should this
   * run die before saving that it was. A retry whose report came out differently saves its own.
   */
  const saveIntent = async () => {
    const checkRunAnnotations = decision.conclusion === undefined ? undefined : annotations.length;
    if (
      progress.decisionLabel === decision.label &&
      progress.checkRunAnnotations === checkRunAnnotations
    ) {
      return;
    }
    if (decision.label === undefined) delete progress.decisionLabel;
    else progress.decisionLabel = decision.label;
    if (checkRunAnnotations === undefined) delete progress.checkRunAnnotations;
    else progress.checkRunAnnotations = checkRunAnnotations;
    await save();
  };
  const writeCheckRun = async () => {
    if (decision.conclusion === undefined || progress.checkRun) return;
    await saveIntent();
    await poster.completeCheckRun(pull, {
      headSha: pr.headSha,
      conclusion: decision.conclusion,
      title: CHECK_TITLE[decision.event],
      summary: report.summary,
      annotations,
      // A retry finds the run an earlier attempt created, instead of adding another.
      externalId: runId,
    });
    progress.checkRun = true;
    await save();
  };
  // Read once per post: other runs' saved progress, and our check runs on the head.
  const theirProgress = memo((theirRun) =>
    deps.store.getText(runKeys(theirRun).posted).then(readTheirs),
  );
  const headCheckRuns = once(() => poster.checkRunsOn(pull, pr.headSha));
  /**
   * Whether the run behind a review on the head finished the head: its check run is on GitHub
   * too. Its saved progress says so, or GitHub lists our App's check run under its external ID
   * with every annotation it was to have (it saved how many before creating the run, and may
   * have died before saving that it was done). With that progress gone (it expires) or
   * unreadable, our App's check run under its external ID is enough. Without a check run
   * (`gate.check_run: off`), the review alone is.
   */
  const finishedHead = async (marker: string) => {
    if (decision.conclusion === undefined) return true;
    const theirRun = markerRun(marker);
    const theirs = await theirProgress(theirRun);
    if (theirs?.checkRun === true) return true;
    const expected = theirs?.checkRunAnnotations;
    // Readable progress without a count: it never got as far as creating its check run.
    if (theirs !== undefined && expected === undefined) return false;
    const listed = (await headCheckRuns()).find((check) => check.externalId === theirRun);
    return listed !== undefined && (expected === undefined || listed.annotations === expected);
  };
  /** Whether a run is done with its post: no attempt of it can come along and write still. */
  const settled = async (theirRun: string) => {
    const theirs = await deps.runs.getRun(theirRun);
    if (theirs?.executionArn === undefined) return true;
    return (await executionStatus(theirs.executionArn)) !== "RUNNING";
  };
  /**
   * A covered run's record, from what its saved progress says it wrote (this attempt's or an
   * earlier one's): on the PR's record too once it has written the PR's summary or label.
   */
  const coveredResult = (wrote: PostProgress) => ({
    ...counts,
    ...(wrote.summary === true || wrote.label === true
      ? {
          pr: {
            headSha: pr.headSha,
            statusLabel: wrote.labelTarget,
            summaryCommentId: wrote.summaryCommentId ?? run.summaryCommentId,
          },
        }
      : {}),
  });
  /**
   * Records the covered run, first bringing the PR up to the head when this run still owes it
   * the summary or the label (by its own progress), the head is still the PR's, and no run for
   * a later event has written the PR's state: the covering run's summary, from its saved
   * progress, and its label (the one it set, else the one its decision called for, else this
   * run's own). Only once the covering run is settled, though: one still to be retried writes
   * them itself, and a label it then leaves to this newer run would be left unset. The label
   * is saved as this run's target before the first write, so its record always carries it.
   */
  const cover = async (coveredBy: string) => {
    const theirRun = markerRun(coveredBy);
    const theirs = await theirProgress(theirRun);
    // An earlier attempt's saved target first: the label it set out to write.
    // Never this run's own decision's: it wasn't posted. With neither (the covering run's
    // decision set no label), it writes none and leaves the PR's recorded label as it is.
    const label = progress.labelTarget ?? theirs?.labelTarget ?? theirs?.decisionLabel;
    const summaryBody = theirs?.summaryBody;
    const owesSummary = !progress.summary && summaryBody !== undefined;
    // Once its summary is out, it owes the label whatever the covering run's progress says now.
    const owesLabel =
      label !== undefined && !progress.label && (progress.summary === true || owesSummary);
    if (
      (owesSummary || owesLabel) &&
      latest.headSha === pr.headSha &&
      (await settled(theirRun)) &&
      !(await deps.runs.newerRunPosted(run))
    ) {
      if (label !== undefined && progress.labelTarget === undefined) {
        progress.labelTarget = label;
        await save();
      }
      // Checked again right before each write, as on the posting path.
      if (owesSummary && !(await deps.runs.newerRunPosted(run))) {
        await writeSummary(summaryBody);
      }
      if (owesLabel && !(await deps.runs.newerRunPosted(run))) await writeLabel(label);
    }
    await deps.runs.coverRun(runId, coveredResult(progress));
  };
  try {
    if (!progress.review) {
      // Our review on the head covers this run when it's complete, or when this run wouldn't
      // be complete either (see `coveringReviews`), and its run finished the head. A run that
      // didn't (it died after its review) leaves the head to this one, which posts a review
      // of its own. Holding the head's claim, nobody adds one between this look and the submit.
      let coveredBy: string | undefined;
      for (const review of coveringReviews(await headReviews(), report.complete)) {
        if (await finishedHead(review.marker)) {
          coveredBy = review.marker;
          break;
        }
      }
      if (coveredBy === undefined && quiet) {
        deps.log("the PR's review already says this; not posting another", { runId });
        progress.quiet = true;
      } else if (coveredBy === undefined) {
        await saveIntent();
        try {
          const review = await poster.submitReview(pull, pr.headSha, payload);
          if (review.id !== undefined) progress.reviewId = review.id;
          for (const [i, finding] of review.payload.commented.entries()) {
            const id = review.commentIds[i];
            if (id !== undefined) commentIds.set(finding, id);
          }
        } catch (error) {
          // Refused, it's not on GitHub: let the next attempt claim both at once. Otherwise (a
          // timeout, a 5xx) it may be, and the claims stay until this task has stopped, when
          // the next attempt takes them over and looks.
          if (refused(error)) {
            await releaseLogged(keys.reviewClaim, claim.etag);
            await releaseLogged(headClaim, head.etag);
          }
          throw error;
        }
      } else {
        deps.log("the head already has our review; not posting another", { runId, coveredBy });
        progress.coveredBy = coveredBy;
      }
      progress.review = true;
      await save();
    }
    if (progress.coveredBy !== undefined) {
      await cover(progress.coveredBy);
      await releaseLogged(headClaim, head.etag);
      deps.log("covered", { runId, coveredBy: progress.coveredBy });
      return {
        runId,
        posted: false,
        coveredBy: progress.coveredBy,
        event: decision.event,
        complete: report.complete,
        findings: report.inline.length + report.body.length,
        reviewed: false,
      };
    }
    await recordFindings();
    await writeCheckRun();
    // The summary comment and the label are the PR's: once a run for a later event has
    // posted they're its, and this one leaves them alone. Checked right before each write.
    if (!progress.summary && !(await deps.runs.newerRunPosted(run))) {
      await writeSummary(report.summary);
    }
    if (decision.label !== undefined && !progress.label && !(await deps.runs.newerRunPosted(run))) {
      await writeLabel(decision.label);
    }
  } catch (error) {
    // The review is on GitHub: record the run, with the summary comment if it got that far, so
    // a later run edits that comment and doesn't review the head again. Covered, it records
    // as covered, and on the PR's record only once it has written the PR's summary or label.
    // Then fail the step, whose retry finishes the rest.
    if (progress.review) {
      const finish =
        progress.coveredBy === undefined
          ? record()
          : deps.runs.coverRun(runId, coveredResult(progress));
      await finish.catch((recordError: unknown) => {
        deps.log("recording a partly posted run failed", {
          runId,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      });
    }
    throw error;
  }

  await record();
  await releaseLogged(headClaim, head.etag);
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
    posted: true,
    event: decision.event,
    complete: report.complete,
    findings: fresh,
    reviewed: !quiet,
  };
}
