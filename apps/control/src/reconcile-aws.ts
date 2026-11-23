import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { statusLabels, type RepoConfig } from "@lgtmoose/config";
import { pendingReplies, pullRequestDispatches, pullRequests, reviewRuns } from "@lgtmoose/db";
import {
  GitHubClient,
  GitHubLabelClient,
  appJwt,
  installationTokenProvider,
  repoPath,
} from "@lgtmoose/poster";
import { syncStatusLabel } from "@lgtmoose/summary";
import { and, asc, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./database.js";
import { repoConfigAt } from "./repo-config.js";

/** How long a recorded reply is left to the run its comment asked for before the reconciler asks again. */
export const PENDING_REPLY_GRACE_MS = 30 * 60_000;
import type {
  HumanComment,
  InstallationGitHub,
  OpenPull,
  ReconcileGitHub,
  ReconcileQueue,
  ReconcileStore,
} from "./reconcile.js";

/** `pull_requests` and `review_runs`, as the reconciler reads and restores them. */
export function drizzleReconcileStore(db: Db, now: () => Date = () => new Date()): ReconcileStore {
  // A run's place among its PR's runs: its event time, else when its row was made.
  const runOrder = sql`coalesce(${reviewRuns.eventAt}, ${reviewRuns.createdAt})`;
  return {
    async pullRequests(repo) {
      const rows = await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          headSha: pullRequests.headSha,
          lastReviewedSha: pullRequests.lastReviewedSha,
          statusLabel: pullRequests.statusLabel,
          commentsThrough: pullRequests.commentsThrough,
          reviewShadow: pullRequests.reviewShadow,
        })
        .from(pullRequests)
        // GitHub names are case-insensitive; rows keep the spelling a job had.
        .where(sql`lower(${pullRequests.repo}) = ${repo.toLowerCase()}`);
      return new Map(
        rows.map((row) => [
          row.number,
          {
            id: row.id,
            headSha: row.headSha,
            lastReviewedSha: row.lastReviewedSha ?? undefined,
            statusLabel: row.statusLabel ?? undefined,
            commentsThrough: row.commentsThrough ?? undefined,
            ...(row.reviewShadow === false ? { reviewLive: true } : {}),
          },
        ]),
      );
    },
    async postedRunAt(pullRequestId, headSha) {
      const [row] = await db
        .select({
          runId: reviewRuns.id,
          headSha: reviewRuns.headSha,
          statusLabel: reviewRuns.statusLabel,
          reviewEvent: reviewRuns.reviewEvent,
          reviewId: reviewRuns.reviewId,
          shadow: reviewRuns.shadow,
        })
        .from(reviewRuns)
        .where(
          and(
            eq(reviewRuns.pullRequestId, pullRequestId),
            eq(reviewRuns.headSha, headSha),
            eq(reviewRuns.wrotePr, true),
          ),
        )
        .orderBy(desc(runOrder))
        .limit(1);
      return row === undefined
        ? undefined
        : {
            runId: row.runId,
            headSha: row.headSha,
            statusLabel: row.statusLabel ?? undefined,
            reviewEvent: row.reviewEvent ?? undefined,
            reviewId: row.reviewId ?? undefined,
            ...(row.shadow === null ? {} : { shadow: row.shadow }),
          };
    },
    async restore(pullRequestId, recordedHead, run) {
      const updated = await db
        .update(pullRequests)
        .set({
          headSha: run.headSha,
          lastReviewedSha: run.headSha,
          ...(run.statusLabel === undefined ? {} : { statusLabel: run.statusLabel }),
          // Without a review of its own (a quiet or covered run), none is recorded: the next
          // run then posts one rather than trust a review of another head.
          lastReviewEvent: run.reviewEvent ?? null,
          lastReviewId: run.reviewId ?? null,
          // Whether that record was on GitHub (NIC-1141): not known, not trusted.
          reviewShadow: run.shadow ?? null,
          updatedAt: now(),
        })
        .where(and(eq(pullRequests.id, pullRequestId), eq(pullRequests.headSha, recordedHead)))
        .returning({ id: pullRequests.id });
      return updated.length > 0;
    },
    async pendingReply(pullRequestId) {
      const [row] = await db
        .select({
          id: pendingReplies.id,
          attempts: pendingReplies.attempts,
          kind: pendingReplies.kind,
        })
        .from(pendingReplies)
        .where(
          and(
            eq(pendingReplies.pullRequestId, pullRequestId),
            eq(pendingReplies.status, "pending"),
            // Not one just recorded: its own run was asked for and is likely under way.
            lt(pendingReplies.createdAt, new Date(now().getTime() - PENDING_REPLY_GRACE_MS)),
          ),
        )
        .orderBy(asc(pendingReplies.createdAt))
        .limit(1);
      return row;
    },
    async checksWaits(repo) {
      const rows = await db
        .select({
          number: pullRequestDispatches.number,
          headSha: pullRequestDispatches.checksWaitSha,
          since: pullRequestDispatches.checksWaitSince,
          state: pullRequestDispatches.checksWaitState,
        })
        .from(pullRequestDispatches)
        .where(
          and(
            eq(pullRequestDispatches.repo, repo.toLowerCase()),
            isNotNull(pullRequestDispatches.checksWaitSha),
          ),
        );
      const waits = new Map<number, { headSha: string; since: Date; state: string | undefined }>();
      for (const row of rows) {
        if (row.headSha === null || row.since === null) continue;
        waits.set(row.number, {
          headSha: row.headSha,
          since: row.since,
          state: row.state ?? undefined,
        });
      }
      return waits;
    },
  };
}

/** Review jobs onto the gateway's FIFO job queue. */
export function sqsReconcileQueue(
  client: Pick<SQSClient, "send">,
  queueUrl: string,
): ReconcileQueue {
  return {
    async send(job, options) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(job),
          MessageGroupId: options.groupId,
          MessageDeduplicationId: options.dedupeId,
        }),
      );
    },
  };
}

const installationsReply = z.array(
  z.object({
    id: z.number().int().positive(),
    account: z.object({ login: z.string() }).nullable(),
  }),
);
const repositoriesReply = z.object({
  repositories: z.array(z.object({ full_name: z.string(), archived: z.boolean().optional() })),
});
const pullsReply = z.array(
  z.object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string() }),
    base: z.object({ sha: z.string() }),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
    draft: z.boolean().optional(),
    labels: z.array(z.object({ name: z.string() })).default([]),
    updated_at: z.string(),
  }),
);
const commentsReply = z.array(
  z.object({
    id: z.number().int().positive(),
    created_at: z.string(),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
  }),
);

const isBot = (user: { login: string; type?: string | undefined }) =>
  user.type === "Bot" || user.login.endsWith("[bot]");

function split(repo: string): { owner: string; repo: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, repo: name };
}

export interface GitHubAppCredentials {
  appId: number;
  privateKey: string;
}

/** GitHub as the App: its installations with the App JWT, the rest with installation tokens. */
export function githubReconcile(
  app: GitHubAppCredentials,
  options: { timeoutMs: number; apiUrl?: string; fetch?: typeof fetch },
): ReconcileGitHub {
  const client = (token: () => Promise<string>) =>
    new GitHubClient({
      token,
      timeoutMs: options.timeoutMs,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const asApp = client(async () => appJwt(app.appId, app.privateKey));
  return {
    async installations() {
      const rows = installationsReply.parse(await asApp.list("/app/installations"));
      return rows.flatMap((row) =>
        row.account === null ? [] : [{ id: row.id, account: row.account.login }],
      );
    },
    async forInstallation(installationId) {
      const github = client(
        installationTokenProvider({
          ...app,
          installationId,
          timeoutMs: options.timeoutMs,
          ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      );
      return installationGitHub(github);
    },
  };
}

/** One installation's calls. Exported for tests with a fake `fetch`. */
export function installationGitHub(github: GitHubClient): InstallationGitHub {
  // One read per repository and base commit: the status labels and the review settings share it.
  const configs = new Map<string, Promise<RepoConfig>>();
  const config = (repo: string, baseSha: string) => {
    const key = `${repo.toLowerCase()}@${baseSha}`;
    let read = configs.get(key);
    if (read === undefined) {
      read = repoConfigAt(github, repo, baseSha);
      // A failed read is tried again next time, not remembered.
      read.catch(() => configs.delete(key));
      configs.set(key, read);
    }
    return read;
  };
  return {
    async repositories() {
      const pages = await github.list(
        "/installation/repositories",
        (page) => repositoriesReply.parse(page).repositories,
      );
      return pages.flatMap((repo) => (repo.archived === true ? [] : [repo.full_name]));
    },
    async openPulls(repo) {
      const rows = pullsReply.parse(await github.list(`${repoPath(split(repo))}/pulls?state=open`));
      return rows.map((row): OpenPull => ({
        number: row.number,
        headSha: row.head.sha,
        baseSha: row.base.sha,
        author: row.user?.login ?? "ghost",
        authorIsBot: row.user === null ? false : isBot(row.user),
        draft: row.draft === true,
        labels: row.labels.map((label) => label.name),
        updatedAt: row.updated_at,
      }));
    },
    async statusLabels(repo, baseSha) {
      return statusLabels(await config(repo, baseSha));
    },
    async reviewSettings(repo, baseSha) {
      return (await config(repo, baseSha)).review;
    },
    async newestHumanComment(repo, number, since) {
      const query = `since=${encodeURIComponent(since.toISOString())}`;
      const base = repoPath(split(repo));
      const [issue, review] = await Promise.all([
        github.list(`${base}/issues/${number}/comments?${query}`),
        github.list(`${base}/pulls/${number}/comments?${query}`),
      ]);
      // `since` filters by last update; only comments made after it are new.
      const candidates = [
        ...commentsReply.parse(issue).map((comment) => ({ ...comment, kind: "comment" as const })),
        ...commentsReply
          .parse(review)
          .map((comment) => ({ ...comment, kind: "review_comment" as const })),
      ].filter(
        (comment) =>
          comment.user !== null &&
          !isBot(comment.user) &&
          Date.parse(comment.created_at) > since.getTime(),
      );
      const newest = candidates.reduce<(typeof candidates)[number] | undefined>(
        (best, comment) =>
          best === undefined || Date.parse(comment.created_at) > Date.parse(best.created_at)
            ? comment
            : best,
        undefined,
      );
      return newest === undefined
        ? undefined
        : ({
            id: newest.id,
            kind: newest.kind,
            author: newest.user?.login ?? "ghost",
          } satisfies HumanComment);
    },
    async syncLabel(repo, number, target, labels) {
      const result = await syncStatusLabel(
        new GitHubLabelClient(github, { ...split(repo), pull: number }),
        { target, statusLabels: labels },
      );
      return result.ok ? { ok: true } : { ok: false, problem: result.problem ?? "not synced" };
    },
  };
}
