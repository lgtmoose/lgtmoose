import { randomUUID } from "node:crypto";
import { statusLabels } from "@lgtmoose/config";
import type { ReviewEvent } from "@lgtmoose/core";
import {
  batchOutputSchema,
  finishReview,
  headKeys,
  runKeys,
  type BatchOutcome,
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
  /**
   * The marker of another run's review that already covers this head, when this run posted
   * nothing because of it. Then it wrote nothing to the PR, and left the PR's record alone.
   */
  coveredBy?: string;
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
 * first. One does once its run has finished the head (see `post`):
 * - a complete review;
 * - an incomplete one that requested changes: until earlier runs' open findings count in a
 *   later run's decision, a complete run could approve with its blocking findings unanswered
 *   (prepare dedupes them as already raised);
 * - an incomplete one, when this run is incomplete too.
 * A complete run posts over an incomplete COMMENT review. A COMMENT review sets no approval
 * state on GitHub, so nothing of it lingers for the new review to clear.
 */
export function coveringReviews(
  reviews: readonly MarkedReview[],
  complete: boolean,
): MarkedReview[] {
  const done = reviews.filter((review) => review.marker.endsWith(":complete"));
  const incomplete = reviews.filter((review) => review.marker.endsWith(":incomplete"));
  return [
    ...done,
    ...(complete
      ? incomplete.filter((review) => review.state === "CHANGES_REQUESTED")
      : incomplete),
  ];
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
  const executionStatus = options.executionStatus ?? (async () => undefined);
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
    return { runId, posted: false, event: report.decision.event, complete: false, findings };
  }

  const { decision } = report;
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
    });
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
      if (coveredBy === undefined) {
        await saveIntent();
        try {
          await poster.submitReview(pull, pr.headSha, payload);
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
      };
    }
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
  deps.log("posted", { runId, event: decision.event, complete: report.complete });
  return {
    runId,
    posted: true,
    event: decision.event,
    complete: report.complete,
    findings: report.inline.length + report.body.length,
  };
}
