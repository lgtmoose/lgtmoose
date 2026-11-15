import {
  declinedFindingSchema,
  type CategoryStatusCount,
  type FeedbackStatus,
} from "@lgtmoose/core";
import { feedback, findings, pullRequests } from "@lgtmoose/db";
import { GitHubClient, GitHubError, installationTokenProvider, repoPath } from "@lgtmoose/poster";
import { and, asc, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./database.js";
import type { FeedbackGitHub, FeedbackStore } from "./feedback.js";
import type { GitHubAppCredentials } from "./reconcile-aws.js";

/** `findings` and `feedback`, as feedback signals read and write them. Our own findings only. */
export function drizzleFeedbackStore(db: Db, now: () => Date = () => new Date()): FeedbackStore {
  return {
    async commentsToRead(since, limit) {
      const rows = await db
        .select({
          findingId: findings.id,
          installationId: pullRequests.installationId,
          repo: pullRequests.repo,
          commentId: findings.githubCommentId,
        })
        .from(findings)
        .innerJoin(pullRequests, eq(pullRequests.id, findings.pullRequestId))
        .where(
          and(
            eq(findings.source, "self"),
            isNotNull(findings.githubCommentId),
            gte(findings.createdAt, since),
          ),
        )
        // Never checked first, then the longest ago: every comment gets its turn.
        .orderBy(sql`${findings.feedbackCheckedAt} asc nulls first`, asc(findings.createdAt))
        .limit(limit);
      return rows.flatMap((row) =>
        row.commentId === null ? [] : [{ ...row, commentId: row.commentId }],
      );
    },
    async replaceReactions(findingId, reactions) {
      await db.transaction(async (tx) => {
        await tx.delete(feedback).where(eq(feedback.findingId, findingId));
        if (reactions.size > 0) {
          await tx
            .insert(feedback)
            .values([...reactions].map(([actor, reaction]) => ({ findingId, actor, reaction })));
        }
        await tx
          .update(findings)
          .set({ feedbackCheckedAt: now() })
          .where(eq(findings.id, findingId));
      });
    },
    async categoryCounts(since) {
      // Per finding: its 👍 and 👎 (one per person, as stored), then grouped.
      const perFinding = db
        .select({
          category: findings.ruleCategory,
          status: findings.status,
          up: sql<number>`count(${feedback.id}) filter (where ${feedback.reaction} = '+1')`
            .mapWith(Number)
            .as("up"),
          down: sql<number>`count(${feedback.id}) filter (where ${feedback.reaction} = '-1')`
            .mapWith(Number)
            .as("down"),
        })
        .from(findings)
        .leftJoin(feedback, eq(feedback.findingId, findings.id))
        .where(and(eq(findings.source, "self"), gte(findings.createdAt, since)))
        .groupBy(findings.id, findings.ruleCategory, findings.status)
        .as("per_finding");
      const rows = await db
        .select({
          category: perFinding.category,
          status: perFinding.status,
          net: sql<number>`sign(${perFinding.up} - ${perFinding.down})`.mapWith(Number),
          findings: sql<number>`count(*)`.mapWith(Number),
          thumbsUp: sql<number>`coalesce(sum(${perFinding.up}), 0)`.mapWith(Number),
          thumbsDown: sql<number>`coalesce(sum(${perFinding.down}), 0)`.mapWith(Number),
        })
        .from(perFinding)
        .groupBy(
          perFinding.category,
          perFinding.status,
          sql`sign(${perFinding.up} - ${perFinding.down})`,
        );
      return rows.map((row): CategoryStatusCount => ({
        category: row.category,
        status: row.status as FeedbackStatus,
        net: Math.sign(row.net) as -1 | 0 | 1,
        findings: row.findings,
        thumbsUp: row.thumbsUp,
        thumbsDown: row.thumbsDown,
      }));
    },
    async declinedFindings(since, limit) {
      const rows = await db
        .select({
          repo: pullRequests.repo,
          prNumber: pullRequests.number,
          baseSha: pullRequests.baseSha,
          path: findings.path,
          line: findings.line,
          startLine: findings.startLine,
          side: findings.side,
          category: findings.ruleCategory,
          severity: findings.severity,
          title: findings.title,
          raisedAtSha: findings.raisedAtSha,
        })
        .from(findings)
        .innerJoin(pullRequests, eq(pullRequests.id, findings.pullRequestId))
        .where(
          and(
            eq(findings.source, "self"),
            eq(findings.status, "declined"),
            gte(findings.createdAt, since),
            isNotNull(findings.path),
            isNotNull(findings.line),
          ),
        )
        .orderBy(desc(findings.updatedAt))
        .limit(limit);
      // Only what can be rebuilt into a fixture: rows that don't validate are left out.
      return rows.flatMap((row) => {
        const parsed = declinedFindingSchema.safeParse({
          repo: row.repo,
          prNumber: row.prNumber,
          path: row.path,
          line: row.line,
          ...(row.startLine === null || row.startLine === row.line
            ? {}
            : { startLine: row.startLine }),
          side: row.side ?? "RIGHT",
          category: row.category,
          severity: row.severity,
          title: row.title,
          raisedAtSha: row.raisedAtSha,
          baseSha: row.baseSha,
        });
        return parsed.success ? [parsed.data] : [];
      });
    },
  };
}

const reactionsReply = z.array(
  z.object({
    content: z.string(),
    created_at: z.string(),
    user: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
  }),
);

/** At most this many reactions are read per comment (one page of 100). */
const REACTIONS_PER_COMMENT = 100;

/** Reactions on review comments, as the App: one installation token per installation. */
export function githubFeedback(
  app: GitHubAppCredentials,
  options: { timeoutMs: number; apiUrl?: string; fetch?: typeof fetch },
): FeedbackGitHub {
  const clients = new Map<number, GitHubClient>();
  const clientFor = (installationId: number) => {
    let client = clients.get(installationId);
    if (client === undefined) {
      client = new GitHubClient({
        token: installationTokenProvider({
          ...app,
          installationId,
          timeoutMs: options.timeoutMs,
          ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
        timeoutMs: options.timeoutMs,
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      clients.set(installationId, client);
    }
    return client;
  };
  return {
    async reactions(installationId, repo, commentId) {
      const [owner = "", name = ""] = repo.split("/");
      try {
        const reply = reactionsReply.parse(
          await clientFor(installationId).request(
            "GET",
            `${repoPath({ owner, repo: name })}/pulls/comments/${commentId}/reactions?per_page=${REACTIONS_PER_COMMENT}`,
          ),
        );
        return reply.flatMap((reaction) =>
          reaction.user === null
            ? []
            : [
                {
                  content: reaction.content,
                  user: reaction.user.login,
                  userIsBot: reaction.user.type === "Bot" || reaction.user.login.endsWith("[bot]"),
                  createdAt: reaction.created_at,
                },
              ],
        );
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return "gone";
        throw error;
      }
    },
  };
}
