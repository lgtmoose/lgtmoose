import { createHash } from "node:crypto";
import { SKIP_LABEL, reviewJobGroupId, type ReviewJob } from "@lgtmoose/core";

/**
 * The reconciler: a scheduled check that compares each installation's open PRs with what the
 * database recorded, and puts right what a missed webhook or a lost write left behind. It makes
 * no model calls itself: a PR that needs a review is put on the job queue, as the gateway would
 * have, and the dispatcher decides from there.
 *
 * For each open PR LGTMoose would review (not a draft, not labelled `skip-lgtmoose`, not opened
 * by a bot, its owner allowed):
 *
 * - Not recorded, or its head is one no run has started for: a review job is queued (a missed
 *   push), but only for a PR updated within the lookback window (`lookbackMs`). An older one
 *   counts as `skippedStale`: a missed webhook is recent, and a first run after a deploy (or a
 *   newly added repository) mustn't review every old open PR. That also stops a PR the
 *   dispatcher drops without recording from being queued forever. The dispatcher dedupes a
 *   queued job against an execution already running for that head.
 * - Its head has a posted run, but the PR's record is another head's (a force-push back to a
 *   reviewed commit, which the dispatcher treats as a duplicate): the PR's record and status
 *   label are put back to that run's.
 * - Its head is the one last reviewed: a status label that drifted (removed, or another status
 *   label added) is synced back to the recorded one.
 * - A run started for its head but none posted (running, or failed): counted, nothing queued. A
 *   failed review isn't retried every interval; the next push or a reopen retries it.
 * - A human comment newer than the comments the PR's record has been through (`commentsThrough`)
 *   is queued as a comment job. Until comment handling arrives (M5) nothing records that time,
 *   so nothing is queued for comments.
 *
 * In shadow mode labels are never written to GitHub, so they aren't checked either.
 */

/** An open PR, as GitHub lists it. */
export interface OpenPull {
  number: number;
  headSha: string;
  baseSha: string;
  author: string;
  /** The author is a bot (an App, or a `[bot]` login). */
  authorIsBot: boolean;
  draft: boolean;
  labels: readonly string[];
  /** The PR's `updated_at`: the job's event time, which orders the PR's jobs. */
  updatedAt: string;
}

/** The newest human comment on a PR since a time. */
export interface HumanComment {
  id: number;
  kind: "comment" | "review_comment";
  author: string;
}

/** GitHub for one installation, as the reconciler uses it. `repo` is "owner/name". */
export interface InstallationGitHub {
  /** The repositories the installation can see. */
  repositories(): Promise<string[]>;
  openPulls(repo: string): Promise<OpenPull[]>;
  /**
   * The status labels of the repo config at `baseSha` (`.lgtmoose.yaml`, defaults without one),
   * as the post step reads them. Throws when the config can't be read or isn't valid.
   */
  statusLabels(repo: string, baseSha: string): Promise<readonly string[]>;
  /** The newest comment by a person created after `since`, issue or review comment. */
  newestHumanComment(repo: string, number: number, since: Date): Promise<HumanComment | undefined>;
  /** Sets `target` as the PR's one status label. */
  syncLabel(
    repo: string,
    number: number,
    target: string,
    statusLabels: readonly string[],
  ): Promise<{ ok: boolean; problem?: string }>;
}

export interface ReconcileGitHub {
  /** The App's installations, with the account each is on. */
  installations(): Promise<{ id: number; account: string }[]>;
  forInstallation(installationId: number): Promise<InstallationGitHub>;
}

/** A PR as the database recorded it (`pull_requests`). */
export interface RecordedPull {
  id: string;
  /** The head the newest run started for. */
  headSha: string;
  lastReviewedSha: string | undefined;
  statusLabel: string | undefined;
  commentsThrough: Date | undefined;
}

/** A run that wrote a PR's state (it posted, or it was covered and wrote the PR's outputs). */
export interface PostedRun {
  runId: string;
  headSha: string;
  statusLabel: string | undefined;
  reviewEvent: string | undefined;
  reviewId: number | undefined;
}

export interface ReconcileStore {
  /** The repository's recorded PRs, by number. */
  pullRequests(repo: string): Promise<Map<number, RecordedPull>>;
  /** The PR's newest run at `headSha` that wrote its state, if any. */
  postedRunAt(pullRequestId: string, headSha: string): Promise<PostedRun | undefined>;
  /**
   * Puts the PR's record back to `run`'s: its head, the head last reviewed, the label (when the
   * run recorded one) and the review. Only while the record is still for `recordedHead`, so a
   * run that started meanwhile isn't overwritten. Returns whether it was.
   */
  restore(pullRequestId: string, recordedHead: string, run: PostedRun): Promise<boolean>;
}

/** Where jobs go: the gateway's FIFO queue, one message group per PR. */
export interface ReconcileQueue {
  send(job: ReviewJob, options: { groupId: string; dedupeId: string }): Promise<void>;
}

export interface ReconcileDeps {
  github: ReconcileGitHub;
  store: ReconcileStore;
  queue: ReconcileQueue;
  /** GitHub orgs or users whose repositories may be reviewed. */
  allowedOrgs: readonly string[];
  /** Labels are left alone in shadow mode: runs don't write them either. */
  shadow: boolean;
  /** Reviews are queued only for PRs updated this recently (milliseconds). */
  lookbackMs: number;
  log(message: string, fields?: Record<string, unknown>): void;
  now?: () => Date;
}

/** What one reconcile found and did, reported as metrics. */
export interface ReconcileCounts {
  /** Open PRs LGTMoose reviews, across installations. */
  openPullRequests: number;
  /** Review jobs queued for heads no run had started for. */
  missedHeads: number;
  /** Comment jobs queued for human comments newer than the record. */
  missedComments: number;
  /** Status labels synced back to the recorded one. */
  labelsResynced: number;
  /** PRs whose record was put back to their head's posted run. */
  statesResynced: number;
  /** PRs whose head has a run that hasn't posted (running or failed). */
  unreviewed: number;
  /** Unrecorded PRs and missed heads left alone: not updated within the lookback window. */
  skippedStale: number;
  /** Active learnings retired for going unused 90 days (`retireUnusedLearnings`). */
  learningsRetired: number;
  /** Installations, repositories or PRs that couldn't be checked, and failed label syncs. */
  errors: number;
}

function emptyCounts(): ReconcileCounts {
  return {
    openPullRequests: 0,
    missedHeads: 0,
    missedComments: 0,
    labelsResynced: 0,
    statesResynced: 0,
    unreviewed: 0,
    skippedStale: 0,
    learningsRetired: 0,
    errors: 0,
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sameLabel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A delivery ID for a job the reconciler queues: the same for the same PR and head (or comment),
 * so the queue drops a copy within its five-minute window and the dispatcher's retry name, made
 * from it, stays the same across intervals.
 */
export function reconcileDeliveryId(key: string): string {
  return `reconcile-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/** Whether the PR's status labels are anything but exactly `target` (by name, ignoring case). */
export function labelDrifted(
  labels: readonly string[],
  target: string,
  statusLabels: readonly string[],
): boolean {
  const status = labels.filter((label) => statusLabels.some((name) => sameLabel(name, label)));
  return status.length !== 1 || !sameLabel(status[0] ?? "", target);
}

/** Checks every installation the App has. Errors are counted and logged, never thrown. */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileCounts> {
  const counts = emptyCounts();
  const allowed = (owner: string) => deps.allowedOrgs.some((org) => sameLabel(org, owner));
  const installations = await deps.github.installations();
  for (const installation of installations) {
    if (!allowed(installation.account)) continue;
    try {
      const github = await deps.github.forInstallation(installation.id);
      for (const repo of await github.repositories()) {
        const [owner = ""] = repo.split("/");
        if (!allowed(owner)) continue;
        try {
          await reconcileRepo(deps, github, installation.id, repo, counts);
        } catch (error) {
          counts.errors += 1;
          deps.log("reconcile: repository not checked", { repo, error: reason(error) });
        }
      }
    } catch (error) {
      counts.errors += 1;
      deps.log("reconcile: installation not checked", {
        installationId: installation.id,
        error: reason(error),
      });
    }
  }
  return counts;
}

async function reconcileRepo(
  deps: ReconcileDeps,
  github: InstallationGitHub,
  installationId: number,
  repo: string,
  counts: ReconcileCounts,
): Promise<void> {
  const pulls = (await github.openPulls(repo)).filter(
    (pull) => !pull.draft && !pull.authorIsBot && !pull.labels.includes(SKIP_LABEL),
  );
  if (pulls.length === 0) return;
  const recorded = await deps.store.pullRequests(repo);
  // One config read per base commit: most of a repository's PRs share one.
  const configs = new Map<string, Promise<readonly string[]>>();
  const statusLabels = (baseSha: string) => {
    let labels = configs.get(baseSha);
    if (labels === undefined) {
      labels = github.statusLabels(repo, baseSha);
      configs.set(baseSha, labels);
    }
    return labels;
  };
  const context = { deps, github, installationId, repo, counts, statusLabels };
  for (const pull of pulls) {
    counts.openPullRequests += 1;
    try {
      await reconcilePull(context, pull, recorded.get(pull.number));
    } catch (error) {
      counts.errors += 1;
      deps.log("reconcile: pull request not checked", {
        repo,
        prNumber: pull.number,
        error: reason(error),
      });
    }
  }
}

interface RepoContext {
  deps: ReconcileDeps;
  github: InstallationGitHub;
  installationId: number;
  repo: string;
  counts: ReconcileCounts;
  statusLabels(baseSha: string): Promise<readonly string[]>;
}

async function reconcilePull(
  context: RepoContext,
  pull: OpenPull,
  record: RecordedPull | undefined,
): Promise<void> {
  const { deps, counts, repo } = context;
  const fields = { repo, prNumber: pull.number, headSha: pull.headSha };
  if (record === undefined) {
    if (await queueReview(context, pull, "pr_opened")) {
      deps.log("reconcile: queued a review for a PR never recorded", fields);
    }
    return;
  }
  if (record.lastReviewedSha === pull.headSha) {
    if (record.statusLabel !== undefined) await resyncLabel(context, pull, record.statusLabel);
  } else {
    const posted = await deps.store.postedRunAt(record.id, pull.headSha);
    if (posted !== undefined) {
      if (await deps.store.restore(record.id, record.headSha, posted)) {
        counts.statesResynced += 1;
        deps.log("reconcile: restored the PR's record to its head's posted run", {
          ...fields,
          runId: posted.runId,
        });
        // Only the run's own label: the record's is the later head's. A run recorded before runs
        // kept their label leaves the PR's label to the next review.
        if (posted.statusLabel !== undefined) {
          await resyncLabel(context, pull, posted.statusLabel);
        }
      }
    } else if (record.headSha === pull.headSha) {
      // A run started for this head and hasn't posted: running, or failed.
      counts.unreviewed += 1;
    } else if (await queueReview(context, pull, "pr_updated")) {
      deps.log("reconcile: queued a review for a missed head", {
        ...fields,
        recordedHead: record.headSha,
      });
    }
  }
  if (record.commentsThrough !== undefined) {
    const comment = await context.github.newestHumanComment(
      repo,
      pull.number,
      record.commentsThrough,
    );
    if (comment !== undefined) {
      await context.deps.queue.send(
        {
          ...jobBase(context, pull),
          kind: comment.kind,
          deliveryId: reconcileDeliveryId(`${repo.toLowerCase()}#comment:${comment.id}`),
          actor: comment.author,
          commentId: comment.id,
        },
        {
          groupId: reviewJobGroupId({ repo, prNumber: pull.number }),
          dedupeId: reconcileDeliveryId(`${repo.toLowerCase()}#comment:${comment.id}`),
        },
      );
      counts.missedComments += 1;
    }
  }
}

function jobBase(context: RepoContext, pull: OpenPull) {
  return {
    installationId: context.installationId,
    repo: context.repo,
    prNumber: pull.number,
    headSha: pull.headSha,
    receivedAt: (context.deps.now?.() ?? new Date()).toISOString(),
    eventAt: new Date(pull.updatedAt).toISOString(),
  };
}

async function queueReview(
  context: RepoContext,
  pull: OpenPull,
  kind: "pr_opened" | "pr_updated",
): Promise<boolean> {
  // Only a PR updated within the lookback window: older ones weren't missed just now. An
  // unreadable time counts as old.
  const now = (context.deps.now?.() ?? new Date()).getTime();
  const updated = Date.parse(pull.updatedAt);
  if (!(now - updated <= context.deps.lookbackMs)) {
    context.counts.skippedStale += 1;
    return false;
  }
  const deliveryId = reconcileDeliveryId(
    `${context.repo.toLowerCase()}#${pull.number}@${pull.headSha}`,
  );
  await context.deps.queue.send(
    { ...jobBase(context, pull), kind, deliveryId, actor: pull.author },
    {
      groupId: reviewJobGroupId({ repo: context.repo, prNumber: pull.number }),
      dedupeId: deliveryId,
    },
  );
  context.counts.missedHeads += 1;
  return true;
}

async function resyncLabel(context: RepoContext, pull: OpenPull, target: string): Promise<void> {
  if (context.deps.shadow) return;
  const statusLabels = await context.statusLabels(pull.baseSha);
  // A label that isn't one of this config's status labels (the config changed since) can't
  // be synced to; the next review sets the right one.
  if (!statusLabels.some((name) => sameLabel(name, target))) return;
  if (!labelDrifted(pull.labels, target, statusLabels)) return;
  const result = await context.github.syncLabel(context.repo, pull.number, target, statusLabels);
  if (result.ok) {
    context.counts.labelsResynced += 1;
    context.deps.log("reconcile: status label synced", {
      repo: context.repo,
      prNumber: pull.number,
      label: target,
    });
  } else {
    context.counts.errors += 1;
    context.deps.log("reconcile: status label not synced", {
      repo: context.repo,
      prNumber: pull.number,
      problem: result.problem,
    });
  }
}

/** The counts as one CloudWatch embedded-metric-format log line (namespace LGTMoose). */
export function metricsLine(counts: ReconcileCounts, at: Date): string {
  const names: Record<keyof ReconcileCounts, string> = {
    openPullRequests: "OpenPullRequests",
    missedHeads: "MissedHeads",
    missedComments: "MissedComments",
    labelsResynced: "LabelsResynced",
    statesResynced: "StatesResynced",
    unreviewed: "Unreviewed",
    skippedStale: "SkippedStale",
    learningsRetired: "LearningsRetired",
    errors: "ReconcileErrors",
  };
  const entries = Object.entries(names) as [keyof ReconcileCounts, string][];
  return JSON.stringify({
    _aws: {
      Timestamp: at.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: "LGTMoose",
          Dimensions: [["Component"]],
          Metrics: entries.map(([, name]) => ({ Name: name, Unit: "Count" })),
        },
      ],
    },
    Component: "reconciler",
    message: "reconciled",
    ...Object.fromEntries(entries.map(([key, name]) => [name, counts[key]])),
  });
}
