import { parseRepoConfig, type RepoConfig } from "@lgtmoose/config";
import type { ReviewJob } from "@lgtmoose/core";
import { describe, expect, it } from "vitest";
import {
  labelDrifted,
  metricsLine,
  reconcile,
  reconcileDeliveryId,
  type HumanComment,
  type InstallationGitHub,
  type OpenPull,
  type PostedRun,
  type ReconcileDeps,
  type RecordedPull,
} from "./reconcile.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
const STATUS = ["Ready for Review", "Requires Changes", "LGTM"] as const;

function pull(overrides: Partial<OpenPull> = {}): OpenPull {
  return {
    number: 7,
    headSha: HEAD,
    baseSha: BASE,
    author: "dev",
    authorIsBot: false,
    draft: false,
    labels: [],
    updatedAt: "2026-11-14T10:00:00Z",
    ...overrides,
  };
}

function recorded(overrides: Partial<RecordedPull> = {}): RecordedPull {
  return {
    id: "pr-1",
    headSha: HEAD,
    lastReviewedSha: HEAD,
    statusLabel: undefined,
    commentsThrough: undefined,
    ...overrides,
  };
}

interface Setup {
  pulls?: OpenPull[];
  records?: Map<number, RecordedPull>;
  posted?: PostedRun;
  restored?: boolean;
  comment?: HumanComment;
  shadow?: boolean;
  installations?: { id: number; account: string }[];
  repos?: string[];
  failPulls?: boolean;
  syncOk?: boolean;
  /** The repo config's `review` settings; left out, the reconciler can't read them. */
  review?: RepoConfig["review"];
}

function setup(options: Setup = {}) {
  const sent: { job: ReviewJob; groupId: string; dedupeId: string }[] = [];
  const synced: { repo: string; number: number; target: string }[] = [];
  const restores: { id: string; recordedHead: string; run: PostedRun }[] = [];
  const logs: string[] = [];
  const configReads: string[] = [];
  const github: InstallationGitHub = {
    repositories: async () => options.repos ?? ["acme/shop"],
    openPulls: async () => {
      if (options.failPulls) throw new Error("boom");
      return options.pulls ?? [pull()];
    },
    statusLabels: async (_repo, baseSha) => {
      configReads.push(baseSha);
      return STATUS;
    },
    ...(options.review === undefined
      ? {}
      : { reviewSettings: async () => options.review as RepoConfig["review"] }),
    newestHumanComment: async () => options.comment,
    syncLabel: async (repo, number, target) => {
      synced.push({ repo, number, target });
      return options.syncOk === false ? { ok: false, problem: "missing label" } : { ok: true };
    },
  };
  const deps: ReconcileDeps = {
    github: {
      installations: async () => options.installations ?? [{ id: 11, account: "acme" }],
      forInstallation: async () => github,
    },
    store: {
      pullRequests: async () => options.records ?? new Map(),
      postedRunAt: async () => options.posted,
      restore: async (id, recordedHead, run) => {
        restores.push({ id, recordedHead, run });
        return options.restored ?? true;
      },
    },
    queue: {
      send: async (job, sendOptions) => {
        sent.push({ job, ...sendOptions });
      },
    },
    allowedOrgs: ["Acme"],
    shadow: options.shadow ?? false,
    lookbackMs: 24 * 3_600_000,
    log: (message) => logs.push(message),
    now: () => new Date("2026-11-14T12:00:00Z"),
  };
  return { deps, sent, synced, restores, logs, configReads };
}

describe("reconcile", () => {
  it("queues a review for an open PR that was never recorded", async () => {
    const { deps, sent } = setup();
    const counts = await reconcile(deps);
    expect(counts).toMatchObject({ openPullRequests: 1, missedHeads: 1, errors: 0 });
    expect(sent).toEqual([
      {
        job: {
          kind: "pr_opened",
          deliveryId: reconcileDeliveryId(`acme/shop#7@${HEAD}`),
          installationId: 11,
          repo: "acme/shop",
          prNumber: 7,
          headSha: HEAD,
          actor: "dev",
          receivedAt: "2026-11-14T12:00:00.000Z",
          eventAt: "2026-11-14T10:00:00.000Z",
        },
        groupId: "acme/shop#7",
        dedupeId: reconcileDeliveryId(`acme/shop#7@${HEAD}`),
      },
    ]);
  });

  it("queues a review for a head no run started for, as a push", async () => {
    const { deps, sent } = setup({
      records: new Map([[7, recorded({ headSha: OLD, lastReviewedSha: OLD })]]),
    });
    expect(await reconcile(deps)).toMatchObject({ missedHeads: 1 });
    expect(sent[0]?.job).toMatchObject({ kind: "pr_updated", headSha: HEAD });
  });

  it("queues no review for an unrecorded PR not updated within the lookback", async () => {
    // Now is 2026-11-14T12:00Z; the window is 24 hours.
    const { deps, sent } = setup({ pulls: [pull({ updatedAt: "2026-11-13T11:59:00Z" })] });
    expect(await reconcile(deps)).toMatchObject({ missedHeads: 0, skippedStale: 1 });
    expect(sent).toEqual([]);
  });

  it("queues no review for a missed head not updated within the lookback", async () => {
    const { deps, sent } = setup({
      pulls: [pull({ updatedAt: "2026-10-01T00:00:00Z" })],
      records: new Map([[7, recorded({ headSha: OLD, lastReviewedSha: OLD })]]),
    });
    expect(await reconcile(deps)).toMatchObject({ missedHeads: 0, skippedStale: 1 });
    expect(sent).toEqual([]);
  });

  it("still syncs labels and restores records of PRs older than the lookback", async () => {
    const old = "2026-10-01T00:00:00Z";
    const { deps, synced, restores } = setup({
      pulls: [
        pull({ number: 7, updatedAt: old, labels: [] }),
        pull({ number: 8, updatedAt: old, labels: [] }),
      ],
      records: new Map([
        [7, recorded({ statusLabel: "LGTM" })],
        [8, recorded({ id: "pr-2", headSha: OLD, lastReviewedSha: OLD })],
      ]),
      posted: {
        runId: "run-x",
        headSha: HEAD,
        statusLabel: "Requires Changes",
        reviewEvent: undefined,
        reviewId: undefined,
      },
    });
    expect(await reconcile(deps)).toMatchObject({
      labelsResynced: 2,
      statesResynced: 1,
      skippedStale: 0,
    });
    expect(synced.map((entry) => entry.number)).toEqual([7, 8]);
    expect(restores).toHaveLength(1);
  });

  it("queues nothing for a head a run started for that hasn't posted", async () => {
    const { deps, sent } = setup({
      records: new Map([[7, recorded({ headSha: HEAD, lastReviewedSha: OLD })]]),
    });
    expect(await reconcile(deps)).toMatchObject({ unreviewed: 1, missedHeads: 0 });
    expect(sent).toEqual([]);
  });

  describe("a PR waiting for CI (NIC-1078)", () => {
    const records = new Map([[7, recorded({ headSha: HEAD, lastReviewedSha: OLD })]]);
    const at = (iso: string) => new Date(iso);

    it("queues a check job for the head it waits on, once per five minutes", async () => {
      const waits = async () =>
        new Map([[7, { headSha: HEAD, since: at("2026-11-14T11:00:00Z"), state: "pending" }]]);
      const { deps, sent } = setup({ records });
      deps.store.checksWaits = waits;
      expect(await reconcile(deps)).toMatchObject({ checksRechecked: 1, unreviewed: 0 });
      expect(sent[0]?.job).toMatchObject({ kind: "pr_checks", headSha: HEAD, prNumber: 7 });
      // The same delivery within five minutes; a new one after.
      const soon = setup({ records });
      soon.deps.store.checksWaits = waits;
      soon.deps.now = () => at("2026-11-14T12:04:00Z");
      await reconcile(soon.deps);
      expect(soon.sent[0]?.dedupeId).toBe(sent[0]?.dedupeId);
      const later = setup({ records });
      later.deps.store.checksWaits = waits;
      later.deps.now = () => at("2026-11-14T12:06:00Z");
      await reconcile(later.deps);
      expect(later.sent[0]?.dedupeId).not.toBe(sent[0]?.dedupeId);
    });

    it("leaves a wait on another head, and an old failed one, alone", async () => {
      for (const wait of [
        { headSha: OLD, since: at("2026-11-14T11:00:00Z"), state: "pending" },
        { headSha: HEAD, since: at("2026-11-01T00:00:00Z"), state: "failed:test" },
      ]) {
        const { deps, sent } = setup({ records });
        deps.store.checksWaits = async () => new Map([[7, wait]]);
        expect(await reconcile(deps)).toMatchObject({ checksRechecked: 0 });
        expect(sent).toEqual([]);
      }
    });
  });

  describe("a missed review label (review.trigger: label)", () => {
    const labelRepo = parseRepoConfig({ review: { trigger: "label" } }).review;
    const waiting = new Map([[7, recorded({ headSha: HEAD, lastReviewedSha: OLD })]]);

    it("queues a label job when the head's run didn't review and the PR has the label", async () => {
      const { deps, sent } = setup({
        pulls: [pull({ labels: ["lgtmoose:review"] })],
        records: waiting,
        review: labelRepo,
      });
      expect(await reconcile(deps)).toMatchObject({ missedLabels: 1, unreviewed: 0 });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.job).toMatchObject({
        kind: "pr_labeled",
        label: "lgtmoose:review",
        headSha: HEAD,
        prNumber: 7,
      });
      expect(sent[0]?.job.botActor).toBeUndefined();
      // Once per head: the same delivery ID on every pass.
      const again = setup({
        pulls: [pull({ labels: ["lgtmoose:review"] })],
        records: waiting,
        review: labelRepo,
      });
      await reconcile(again.deps);
      expect(again.sent[0]?.dedupeId).toBe(sent[0]?.dedupeId);
    });

    it("queues nothing without the label, in auto mode, or outside the lookback", async () => {
      for (const options of [
        { pulls: [pull({ labels: ["bug"] })], review: labelRepo },
        { pulls: [pull({ labels: ["lgtmoose:review"] })], review: parseRepoConfig({}).review },
        {
          pulls: [pull({ labels: ["lgtmoose:review"], updatedAt: "2026-11-01T00:00:00Z" })],
          review: labelRepo,
        },
      ]) {
        const { deps, sent } = setup({ ...options, records: waiting });
        expect(await reconcile(deps)).toMatchObject({ missedLabels: 0, unreviewed: 1 });
        expect(sent).toEqual([]);
      }
    });
  });

  it("leaves drafts, skip-labelled PRs, bots' PRs and other owners alone", async () => {
    const { deps, sent } = setup({
      pulls: [
        pull({ number: 1, draft: true }),
        pull({ number: 2, labels: ["skip-lgtmoose"] }),
        pull({ number: 3, authorIsBot: true, author: "dependabot[bot]" }),
      ],
      repos: ["acme/shop", "evil/fork"],
      installations: [
        { id: 11, account: "acme" },
        { id: 12, account: "other" },
      ],
    });
    expect(await reconcile(deps)).toMatchObject({ openPullRequests: 0, missedHeads: 0 });
    expect(sent).toEqual([]);
  });

  it("syncs a drifted status label back to the recorded one", async () => {
    const { deps, synced, configReads } = setup({
      pulls: [
        pull({ number: 7, labels: ["LGTM", "bug"] }),
        pull({ number: 8, labels: ["requires changes"] }),
      ],
      records: new Map([
        [7, recorded({ statusLabel: "Requires Changes" })],
        [8, recorded({ id: "pr-2", statusLabel: "Requires Changes" })],
      ]),
    });
    expect(await reconcile(deps)).toMatchObject({ labelsResynced: 1, errors: 0 });
    // #8 already has it (labels compare without case).
    expect(synced).toEqual([{ repo: "acme/shop", number: 7, target: "Requires Changes" }]);
    // One config read for the base both PRs share.
    expect(configReads).toEqual([BASE]);
  });

  it("counts a label sync that fails as an error", async () => {
    const { deps } = setup({
      pulls: [pull({ labels: [] })],
      records: new Map([[7, recorded({ statusLabel: "LGTM" })]]),
      syncOk: false,
    });
    expect(await reconcile(deps)).toMatchObject({ labelsResynced: 0, errors: 1 });
  });

  it("leaves labels alone in shadow mode", async () => {
    const { deps, synced } = setup({
      shadow: true,
      pulls: [pull({ labels: [] })],
      records: new Map([[7, recorded({ statusLabel: "LGTM" })]]),
    });
    expect(await reconcile(deps)).toMatchObject({ labelsResynced: 0 });
    expect(synced).toEqual([]);
  });

  it("restores the record and label after a force-push back to a reviewed head", async () => {
    const posted: PostedRun = {
      runId: "run-x",
      headSha: HEAD,
      statusLabel: "LGTM",
      reviewEvent: "APPROVE",
      reviewId: 99,
    };
    const { deps, sent, restores, synced } = setup({
      pulls: [pull({ labels: ["Requires Changes"] })],
      records: new Map([
        [7, recorded({ headSha: OLD, lastReviewedSha: OLD, statusLabel: "Requires Changes" })],
      ]),
      posted,
    });
    expect(await reconcile(deps)).toMatchObject({
      statesResynced: 1,
      labelsResynced: 1,
      missedHeads: 0,
    });
    expect(restores).toEqual([{ id: "pr-1", recordedHead: OLD, run: posted }]);
    expect(synced).toEqual([{ repo: "acme/shop", number: 7, target: "LGTM" }]);
    expect(sent).toEqual([]);
  });

  it("leaves the label alone when the restored run recorded none", async () => {
    const { deps, synced } = setup({
      pulls: [pull({ labels: [] })],
      records: new Map([
        [7, recorded({ headSha: OLD, lastReviewedSha: OLD, statusLabel: "Requires Changes" })],
      ]),
      posted: {
        runId: "run-old",
        headSha: HEAD,
        statusLabel: undefined,
        reviewEvent: undefined,
        reviewId: undefined,
      },
    });
    expect(await reconcile(deps)).toMatchObject({ statesResynced: 1, labelsResynced: 0 });
    expect(synced).toEqual([]);
  });

  it("syncs no label when the record changed meanwhile", async () => {
    const { deps, synced } = setup({
      pulls: [pull({ labels: [] })],
      records: new Map([[7, recorded({ headSha: OLD, lastReviewedSha: OLD })]]),
      posted: {
        runId: "run-x",
        headSha: HEAD,
        statusLabel: "LGTM",
        reviewEvent: undefined,
        reviewId: undefined,
      },
      restored: false,
    });
    expect(await reconcile(deps)).toMatchObject({ statesResynced: 0, labelsResynced: 0 });
    expect(synced).toEqual([]);
  });

  it("queues a comment job for a human comment newer than the record", async () => {
    const { deps, sent } = setup({
      records: new Map([[7, recorded({ commentsThrough: new Date("2026-11-14T09:00:00Z") })]]),
      comment: { id: 555, kind: "review_comment", author: "alice" },
    });
    expect(await reconcile(deps)).toMatchObject({ missedComments: 1 });
    expect(sent[0]?.job).toMatchObject({
      kind: "review_comment",
      commentId: 555,
      actor: "alice",
      prNumber: 7,
    });
  });

  it("asks for no comments while the record has none through", async () => {
    const { deps, sent } = setup({
      records: new Map([[7, recorded()]]),
      comment: { id: 555, kind: "comment", author: "alice" },
    });
    expect(await reconcile(deps)).toMatchObject({ missedComments: 0 });
    expect(sent).toEqual([]);
  });

  it("asks again for a run for a reply no run judged, once per attempt", async () => {
    const { deps, sent } = setup({ records: new Map([[7, recorded()]]) });
    let waiting: { id: string; attempts: number } | undefined = { id: "r-1", attempts: 1 };
    deps.store.pendingReply = async () => waiting;
    expect(await reconcile(deps)).toMatchObject({ pendingReplies: 1 });
    const replies = sent.filter((entry) => entry.job.requested === "replies");
    expect(replies).toMatchObject([
      {
        job: {
          kind: "pr_updated",
          requested: "replies",
          deliveryId: reconcileDeliveryId("acme/shop#7:replies:r-1:1"),
          prNumber: 7,
        },
        groupId: "acme/shop#7",
      },
    ]);
    waiting = undefined;
    expect(await reconcile(deps)).toMatchObject({ pendingReplies: 0 });
  });

  it("asks for a run for explains for an explain no run answered", async () => {
    const { deps, sent } = setup({ records: new Map([[7, recorded()]]) });
    deps.store.pendingReply = async () => ({ id: "r-2", attempts: 0, kind: "explain_pr" });
    await reconcile(deps);
    expect(sent.filter((entry) => entry.job.requested === "explain")).toMatchObject([
      { job: { deliveryId: reconcileDeliveryId("acme/shop#7:explain:r-2:0") } },
    ]);
  });

  it("counts a repository it can't read as an error and goes on", async () => {
    const { deps } = setup({ failPulls: true, repos: ["acme/a", "acme/b"] });
    expect(await reconcile(deps)).toMatchObject({ errors: 2 });
  });
});

describe("labelDrifted", () => {
  it("is false only for exactly the target among the status labels", () => {
    expect(labelDrifted(["lgtm", "bug"], "LGTM", STATUS)).toBe(false);
    expect(labelDrifted([], "LGTM", STATUS)).toBe(true);
    expect(labelDrifted(["LGTM", "Requires Changes"], "LGTM", STATUS)).toBe(true);
    expect(labelDrifted(["Ready for Review"], "LGTM", STATUS)).toBe(true);
  });
});

describe("metricsLine", () => {
  it("is one embedded-metric-format line with every count", () => {
    const line = JSON.parse(
      metricsLine(
        {
          openPullRequests: 3,
          missedHeads: 1,
          missedLabels: 6,
          missedComments: 0,
          checksRechecked: 0,
          pendingReplies: 0,
          labelsResynced: 2,
          statesResynced: 0,
          unreviewed: 1,
          skippedStale: 4,
          learningsRetired: 5,
          feedbackCommentsRead: 7,
          categoriesFlagged: 2,
          bootstrapsStarted: 1,
          errors: 0,
        },
        new Date(1000),
      ),
    ) as Record<string, unknown> & {
      _aws: { Timestamp: number; CloudWatchMetrics: { Namespace: string; Metrics: unknown[] }[] };
    };
    expect(line._aws.Timestamp).toBe(1000);
    expect(line._aws.CloudWatchMetrics[0]?.Namespace).toBe("LGTMoose");
    expect(line._aws.CloudWatchMetrics[0]?.Metrics).toHaveLength(15);
    expect(line).toMatchObject({
      BootstrapsStarted: 1,
      MissedLabels: 6,
      LearningsRetired: 5,
      FeedbackCommentsRead: 7,
      CategoriesFlagged: 2,
      OpenPullRequests: 3,
      MissedHeads: 1,
      LabelsResynced: 2,
      SkippedStale: 4,
    });
  });
});
