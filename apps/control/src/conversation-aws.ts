import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { reviewJobGroupId } from "@lgtmoose/core";
import {
  findingEvents,
  findings,
  pendingReplies,
  pullRequestDispatches,
  pullRequests,
} from "@lgtmoose/db";
import { GitHubError, repoPath, type GitHubClient } from "@lgtmoose/poster";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./database.js";
import { drizzleDispatchStore } from "./dispatch-aws.js";
import type {
  ConversationDeps,
  ConversationGitHub,
  ConversationStore,
  ReactableKind,
  StoredFinding,
} from "./conversation.js";
import { collaboratorPermission, orgRole } from "./github-access.js";
import { repoConfigAt } from "./repo-config.js";

type Log = (message: string, fields?: Record<string, unknown>) => void;

const userSchema = z.object({ login: z.string(), type: z.string().optional() }).nullable();
const commentReply = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable().optional(),
  user: userSchema,
  in_reply_to_id: z.number().int().positive().optional(),
  created_at: z.string().optional(),
});
const reviewReply = z.object({
  body: z.string().nullable().optional(),
  user: userSchema,
  submitted_at: z.string().nullable().optional(),
});
const pullReply = z.object({
  state: z.string(),
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
  user: userSchema,
});
const fileReply = z.array(z.object({ filename: z.string() }));

function split(repo: string): { owner: string; repo: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, repo: name };
}

const isBot = (user: { login: string; type?: string | undefined }) =>
  user.type === "Bot" || user.login.endsWith("[bot]");

/** Where a comment of each kind lives: issue comments, or review comments on the diff. */
const commentPath = (kind: ReactableKind, repo: string, id: number) =>
  `${repoPath(split(repo))}/${kind === "comment" ? "issues" : "pulls"}/comments/${id}`;

/** GitHub for one installation, as the conversation handler uses it. */
export function githubConversation(
  client: Pick<GitHubClient, "request" | "list">,
  slug: () => Promise<string>,
  log: Log,
): ConversationGitHub {
  return {
    slug,
    async comment(kind, repo, commentId) {
      let reply: z.infer<typeof commentReply>;
      try {
        reply = commentReply.parse(await client.request("GET", commentPath(kind, repo, commentId)));
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return undefined;
        throw error;
      }
      return {
        body: reply.body ?? "",
        author: reply.user?.login ?? "ghost",
        authorIsBot: reply.user === null ? true : isBot(reply.user),
        // Replies on GitHub are to the thread's first comment.
        ...(kind === "review_comment" ? { threadRootId: reply.in_reply_to_id ?? reply.id } : {}),
        ...(reply.created_at === undefined ? {} : { createdAt: reply.created_at }),
      };
    },
    async review(repo, number, reviewId) {
      let reply: z.infer<typeof reviewReply>;
      try {
        reply = reviewReply.parse(
          await client.request(
            "GET",
            `${repoPath(split(repo))}/pulls/${number}/reviews/${reviewId}`,
          ),
        );
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return undefined;
        throw error;
      }
      return {
        body: reply.body ?? "",
        author: reply.user?.login ?? "ghost",
        authorIsBot: reply.user === null ? true : isBot(reply.user),
        ...(typeof reply.submitted_at === "string" ? { createdAt: reply.submitted_at } : {}),
      };
    },
    async pull(repo, number) {
      const reply = pullReply.parse(
        await client.request("GET", `${repoPath(split(repo))}/pulls/${number}`),
      );
      return {
        headSha: reply.head.sha,
        baseSha: reply.base.sha,
        author: reply.user?.login ?? "ghost",
        open: reply.state === "open",
      };
    },
    async trustedBots(repo, baseSha) {
      return (await repoConfigAt(client, repo, baseSha)).review.trusted_bots;
    },
    async files(repo, number) {
      const rows = fileReply.parse(
        await client.list(`${repoPath(split(repo))}/pulls/${number}/files`),
      );
      return rows.map((row) => row.filename);
    },
    permission: (repo, login) => collaboratorPermission(client, split(repo), login, log),
    orgRole: (org, login) => orgRole(client, org, login, log),
    async react(kind, repo, commentId, content) {
      await client.request("POST", `${commentPath(kind, repo, commentId)}/reactions`, { content });
    },
    async reply(kind, repo, number, commentId, body) {
      const base = repoPath(split(repo));
      if (kind === "review_comment") {
        await client.request("POST", `${base}/pulls/${number}/comments/${commentId}/replies`, {
          body,
        });
      } else {
        // An issue comment, and for a submitted review too: reviews take no replies or reactions.
        await client.request("POST", `${base}/issues/${number}/comments`, { body });
      }
    },
  };
}

const lower = (repo: string) => repo.toLowerCase();

/**
 * How long a claimed handle hint may go unposted before another comment may claim it (NIC-1119):
 * longer than the conversation Lambda's timeout, so a live post is never raced.
 */
export const HANDLE_HINT_CLAIM_MS = 15 * 60_000;

/**
 * How old a claimant's own unposted claim must be before its retry may claim it again: longer
 * than a post takes, so no attempt of it is still posting. Rarely, a hint is posted twice: an
 * attempt posts it but dies before recording that, and its retry after this window posts it
 * again. Or two overlapping deliveries of one comment straddle the window. That's accepted, as
 * the hint is only a courtesy.
 */
export const HANDLE_HINT_RETRY_MS = 2 * 60_000;

const findingColumns = {
  id: findings.id,
  severity: findings.severity,
  ruleCategory: findings.ruleCategory,
  title: findings.title,
  body: findings.body,
  path: findings.path,
  line: findings.line,
  status: findings.status,
  raisedAtSha: findings.raisedAtSha,
};

function toStored(row: {
  id: string;
  severity: StoredFinding["severity"];
  ruleCategory: string;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
  status: string;
  raisedAtSha: string;
}): StoredFinding {
  return { ...row, path: row.path ?? undefined, line: row.line ?? undefined };
}

/** The conversation handler's tables: pause state, our findings and their events. */
export function drizzleConversationStore(
  db: Db,
  now: () => Date = () => new Date(),
): ConversationStore {
  const dispatch = drizzleDispatchStore(db, now);
  // The handle-hint claims this store made, by PR and claimant, and when (NIC-1119): a release
  // clears only the claim it made, never a later one.
  const claims = new Map<string, Date>();
  const claimKey = (repo: string, number: number, claimant: string) =>
    `${lower(repo)}#${number}#${claimant}`;
  const ofPull = (repo: string, number: number) =>
    and(sql`lower(${pullRequests.repo}) = ${lower(repo)}`, eq(pullRequests.number, number));
  return {
    async setPaused(repo, number, by) {
      const values = {
        pausedAt: by === undefined ? null : now(),
        pausedBy: by ?? null,
        // resume starts the automatic-review count over. Pausing leaves it where it was.
        ...(by === undefined
          ? {
              reviewCountResetAt: now(),
              reviewRequestHead: null,
              excludedAutomaticRunId: null,
            }
          : {}),
      };
      await db
        .insert(pullRequestDispatches)
        // A PR the dispatcher hasn't seen yet: no event acted on, so any job is newer.
        .values({ repo: lower(repo), number, lastEventAt: new Date(0), ...values })
        .onConflictDoUpdate({
          target: [pullRequestDispatches.repo, pullRequestDispatches.number],
          set: { ...values, updatedAt: now() },
        });
    },
    reviewedHead: (repo, number, headSha) => dispatch.reviewed(repo, number, headSha),
    async findingByComment(repo, number, commentId) {
      const [row] = await db
        .select(findingColumns)
        .from(findings)
        .innerJoin(pullRequests, eq(findings.pullRequestId, pullRequests.id))
        .where(
          and(
            ofPull(repo, number),
            eq(findings.source, "self"),
            eq(findings.githubCommentId, commentId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : toStored(row);
    },
    async findingsAt(repo, number, path, line) {
      const rows = await db
        .select(findingColumns)
        .from(findings)
        .innerJoin(pullRequests, eq(findings.pullRequestId, pullRequests.id))
        .where(
          and(
            ofPull(repo, number),
            eq(findings.source, "self"),
            eq(findings.path, path),
            gte(findings.line, line),
            or(
              lte(findings.startLine, line),
              and(isNull(findings.startLine), eq(findings.line, line)),
            ),
          ),
        )
        .limit(3);
      return rows.map(toStored);
    },
    async decline(findingId, login, commentId) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(findings)
          .set({ status: "declined", updatedAt: now() })
          .where(and(eq(findings.id, findingId), inArray(findings.status, ["open", "outdated"])))
          .returning({ sha: findings.raisedAtSha });
        if (row === undefined) return false;
        await tx.insert(findingEvents).values({
          findingId,
          type: "declined",
          actor: "human",
          actorLogin: login,
          sha: row.sha,
          githubCommentId: commentId,
        });
        return true;
      });
    },
    async declineReason(findingId) {
      const [row] = await db
        .select({
          author: findingEvents.actorLogin,
          body: pendingReplies.body,
          // A decline from the CLI or the dashboard (NIC-1140): its reason, with no reply.
          reason: findingEvents.reason,
        })
        .from(findingEvents)
        .leftJoin(pendingReplies, eq(pendingReplies.githubCommentId, findingEvents.githubCommentId))
        .where(
          and(
            eq(findingEvents.findingId, findingId),
            inArray(findingEvents.type, ["declined", "dispute_answered"]),
            isNotNull(findingEvents.actorLogin),
            or(isNotNull(pendingReplies.body), isNotNull(findingEvents.reason)),
          ),
        )
        .orderBy(desc(findingEvents.createdAt))
        .limit(1);
      const body = row?.body ?? row?.reason ?? undefined;
      return row === undefined || row.author === null || body === undefined
        ? undefined
        : { author: row.author, body };
    },
    async commentsThrough(repo, number, at) {
      await db
        .update(pullRequests)
        .set({
          commentsThrough: sql`greatest(coalesce(${pullRequests.commentsThrough}, ${at}), ${at})`,
          updatedAt: now(),
        })
        .where(ofPull(repo, number));
    },
    async claimHandleHint(repo, number, claimant) {
      const at = now();
      const stale = new Date(at.getTime() - HANDLE_HINT_CLAIM_MS);
      const retry = new Date(at.getTime() - HANDLE_HINT_RETRY_MS);
      const d = pullRequestDispatches;
      // One statement: two comments handled at once can't both claim it. A claim whose hint was
      // never posted is taken again by the same comment's retry once no attempt can still be
      // posting (`HANDLE_HINT_RETRY_MS`), or by any comment once it's stale (the Lambda died in
      // between). A posted hint is never claimed again.
      const rows = await db
        .insert(d)
        .values({
          repo: lower(repo),
          number,
          lastEventAt: new Date(0),
          handleHintAt: at,
          handleHintClaimant: claimant,
        })
        .onConflictDoUpdate({
          target: [d.repo, d.number],
          set: {
            handleHintAt: at,
            handleHintPosted: false,
            handleHintClaimant: claimant,
            updatedAt: at,
          },
          setWhere: sql`(${d.handleHintAt} is null and not ${d.handleHintPosted}) or (not ${d.handleHintPosted} and (${d.handleHintAt} < ${stale} or (${d.handleHintClaimant} = ${claimant} and ${d.handleHintAt} < ${retry})))`,
        })
        .returning({ repo: d.repo });
      if (rows.length > 0) {
        // What a failed post gives back: this claim, and no later one.
        claims.set(claimKey(repo, number, claimant), at);
        return "claimed";
      }
      // Not ours to post now: say whose it is and whether it was posted, so this comment is
      // never told it did nothing when it, or another comment still posting, has the hint.
      const [held] = await db
        .select({ posted: d.handleHintPosted, claimant: d.handleHintClaimant })
        .from(d)
        .where(and(eq(d.repo, lower(repo)), eq(d.number, number)));
      const posted = held?.posted === true;
      if (held?.claimant === claimant) return posted ? "mine-posted" : "mine-pending";
      return posted ? "other-posted" : "other-pending";
    },
    async handleHintPosted(repo, number) {
      // Posted: nothing of this PR's is released any more.
      const prefix = `${lower(repo)}#${number}#`;
      for (const key of claims.keys()) if (key.startsWith(prefix)) claims.delete(key);
      await db
        .update(pullRequestDispatches)
        .set({ handleHintPosted: true, updatedAt: now() })
        .where(
          and(
            eq(pullRequestDispatches.repo, lower(repo)),
            eq(pullRequestDispatches.number, number),
          ),
        );
    },
    async releaseHandleHint(repo, number, claimant) {
      // Only the claim this store made for this claimant, still unposted: never one another
      // comment, or a later attempt of the same one, has taken since.
      const key = claimKey(repo, number, claimant);
      const at = claims.get(key);
      if (at === undefined) return;
      claims.delete(key);
      await db
        .update(pullRequestDispatches)
        .set({
          handleHintAt: null,
          handleHintPosted: false,
          handleHintClaimant: null,
          updatedAt: now(),
        })
        .where(
          and(
            eq(pullRequestDispatches.repo, lower(repo)),
            eq(pullRequestDispatches.number, number),
            eq(pullRequestDispatches.handleHintClaimant, claimant),
            eq(pullRequestDispatches.handleHintAt, at),
            eq(pullRequestDispatches.handleHintPosted, false),
          ),
        );
    },
  };
}

/** Reviews a command asks for, onto the gateway's FIFO job queue in the PR's group. */
export function sqsJobQueue(
  client: Pick<SQSClient, "send">,
  queueUrl: string,
): ConversationDeps["queue"] {
  return {
    async send(job) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(job),
          MessageGroupId: reviewJobGroupId(job),
          MessageDeduplicationId: job.deliveryId,
        }),
      );
    },
  };
}
