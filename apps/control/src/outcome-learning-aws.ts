import { feedback, findingEvents, findings, pendingReplies, pullRequests } from "@lgtmoose/db";
import type { LearningDeps, LearningStore } from "@lgtmoose/learnings";
import type { GitHubClient } from "@lgtmoose/poster";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./database.js";
import type { AnswerLearningStore } from "./finding-answers.js";
import { collaboratorPermission, orgRole } from "./github-access.js";
import {
  learnFromFixes,
  learnFromRejections,
  type OutcomeFinding,
  type OutcomeStore,
  type RejectedFinding,
} from "./outcome-learning.js";
import type { ControlDeps } from "./ports.js";

/** The most rejected findings read for one repeat check. */
const MAX_REJECTED = 500;

/** `findings`, `finding_events`, `pending_replies` and `feedback`, as outcome learning reads them. */
export function drizzleOutcomeStore(db: Db): OutcomeStore {
  return {
    async findings(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .select({
          id: findings.id,
          repo: pullRequests.repo,
          prNumber: pullRequests.number,
          category: findings.ruleCategory,
          title: findings.title,
          learningIds: findings.learningIds,
        })
        .from(findings)
        .innerJoin(pullRequests, eq(pullRequests.id, findings.pullRequestId))
        .where(and(inArray(findings.id, [...new Set(ids)]), eq(findings.source, "self")));
      return rows.map((row): OutcomeFinding => ({ ...row, learningIds: row.learningIds ?? [] }));
    },
    async rejected(repo, category, since) {
      // Declined or disputed, or not fixed with more 👎 than 👍 (as feedback counts it).
      const net = sql<number>`coalesce((select sum(case when ${feedback.reaction} = '+1' then 1 else -1 end) from ${feedback} where ${feedback.findingId} = ${findings.id}), 0)`;
      const rows = await db
        .select({
          findingId: findings.id,
          prNumber: pullRequests.number,
          title: findings.title,
          status: findings.status,
          updatedAt: findings.updatedAt,
        })
        .from(findings)
        .innerJoin(pullRequests, eq(pullRequests.id, findings.pullRequestId))
        .where(
          and(
            sql`lower(${pullRequests.repo}) = ${repo.toLowerCase()}`,
            eq(findings.ruleCategory, category),
            eq(findings.source, "self"),
            gte(findings.createdAt, since),
            sql`(${findings.status} in ('declined', 'disputed') or (${findings.status} <> 'fixed' and ${net} < 0))`,
          ),
        )
        .orderBy(desc(findings.updatedAt))
        .limit(MAX_REJECTED);
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.findingId);
      // The replies that declined or disputed them: their authors and comments.
      const closes = await db
        .select({
          findingId: findingEvents.findingId,
          login: findingEvents.actorLogin,
          commentId: findingEvents.githubCommentId,
          // A decline from the CLI or the dashboard (NIC-1140) has its reason here instead.
          reason: findingEvents.reason,
        })
        .from(findingEvents)
        .where(
          and(
            inArray(findingEvents.findingId, ids),
            inArray(findingEvents.type, ["declined", "dispute_answered"]),
            isNotNull(findingEvents.actorLogin),
          ),
        )
        .orderBy(desc(findingEvents.createdAt));
      const commentIds = closes.flatMap((close) =>
        close.commentId === null ? [] : [close.commentId],
      );
      const bodies =
        commentIds.length === 0
          ? []
          : await db
              .select({ commentId: pendingReplies.githubCommentId, body: pendingReplies.body })
              .from(pendingReplies)
              .where(inArray(pendingReplies.githubCommentId, commentIds));
      const bodyOf = new Map(bodies.map((row) => [row.commentId, row.body]));
      const downs = await db
        .select({ findingId: feedback.findingId, actor: feedback.actor })
        .from(feedback)
        .where(and(inArray(feedback.findingId, ids), eq(feedback.reaction, "-1")));
      return rows.map((row): RejectedFinding => {
        const mine = closes.filter((close) => close.findingId === row.findingId);
        const reasons = mine.flatMap((close) => {
          const body =
            close.commentId === null
              ? (close.reason ?? undefined)
              : (bodyOf.get(close.commentId) ?? close.reason ?? undefined);
          return body === undefined || close.login === null ? [] : [{ author: close.login, body }];
        });
        const rejectors = [
          ...mine.flatMap((close) => (close.login === null ? [] : [close.login])),
          // A 👎 rejects it only when the reactions came out against it.
          ...(row.status === "declined" || row.status === "disputed"
            ? []
            : downs.filter((down) => down.findingId === row.findingId).map((down) => down.actor)),
        ];
        return {
          findingId: row.findingId,
          prNumber: row.prNumber,
          title: row.title,
          rejectors: [...new Set(rejectors)],
          reasons,
          at: row.updatedAt,
        };
      });
    },
  };
}

/**
 * Declines from the CLI or the dashboard that outcome learning hasn't read (NIC-1140), with the
 * installation that reaches their repository.
 */
export function drizzleAnswerLearningStore(db: Db): AnswerLearningStore {
  return {
    async pendingAnswers(limit) {
      const rows = await db
        .select({
          eventId: findingEvents.id,
          findingId: findingEvents.findingId,
          installationId: pullRequests.installationId,
          repo: pullRequests.repo,
        })
        .from(findingEvents)
        .innerJoin(findings, eq(findings.id, findingEvents.findingId))
        .innerJoin(pullRequests, eq(pullRequests.id, findings.pullRequestId))
        .where(eq(findingEvents.learnPending, true))
        .orderBy(asc(findingEvents.createdAt))
        .limit(limit);
      return rows;
    },
    async answersLearned(eventIds) {
      if (eventIds.length === 0) return;
      await db
        .update(findingEvents)
        .set({ learnPending: false })
        .where(inArray(findingEvents.id, [...eventIds]));
    },
  };
}

/** What the post step and the reconciler call after findings were rejected or fixed. */
export type OutcomeLearner = NonNullable<ControlDeps["outcomes"]>;

/**
 * Outcome learning (NIC-1081) for the control task and the reconciler: the store, the learnings
 * policy bound to the installation's GitHub access (read with its own token), and the repeat
 * threshold.
 */
export function outcomeLearner(input: {
  db: Db;
  learnings: LearningStore;
  client(installationId: number): Pick<GitHubClient, "request">;
  maxPendingPerAuthor?: number;
  repeatThreshold?: number;
  log: (message: string, fields?: Record<string, unknown>) => void;
}): OutcomeLearner {
  const store = drizzleOutcomeStore(input.db);
  const { log } = input;
  const policy = (installationId: number, repo: string): LearningDeps => {
    const client = input.client(installationId);
    const [owner = "", name = ""] = repo.split("/");
    return {
      store: input.learnings,
      permissions: (_repo, login) =>
        collaboratorPermission(client, { owner, repo: name }, login, log),
      orgRoles: (org, login) => orgRole(client, org, login, log),
      ...(input.maxPendingPerAuthor === undefined
        ? {}
        : { maxPendingPerAuthor: input.maxPendingPerAuthor }),
    };
  };
  return {
    async rejected(installationId, repo, rejected) {
      await learnFromRejections(
        {
          store,
          learnings: policy(installationId, repo),
          ...(input.repeatThreshold === undefined
            ? {}
            : { repeatThreshold: input.repeatThreshold }),
          log,
        },
        rejected.map((entry) => entry.findingId),
        new Map(
          rejected.flatMap((entry) =>
            entry.commentId === undefined ? [] : [[entry.findingId, entry.commentId] as const],
          ),
        ),
      );
    },
    async fixed(fixes) {
      await learnFromFixes({ store, learnings: { store: input.learnings }, log }, fixes);
    },
  };
}
