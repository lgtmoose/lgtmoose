import { pendingReplies, pullRequests } from "@lgtmoose/db";
import { redactSensitive } from "@lgtmoose/learnings";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./database.js";
import { MAX_JUDGE_ATTEMPTS, type PendingReply, type ReplyStore } from "./replies.js";

/** The longest reply body kept for the judge; a longer one is cut. */
export const MAX_REPLY_BODY = 4000;

/** `pending_replies` in Postgres. */
export function drizzleReplyStore(db: Db, now: () => Date = () => new Date()): ReplyStore {
  const finish: ReplyStore["finish"] = async (ids, status) => {
    if (ids.length === 0) return;
    await db
      .update(pendingReplies)
      .set({ status, updatedAt: now() })
      .where(and(inArray(pendingReplies.id, [...ids]), eq(pendingReplies.status, "pending")));
  };
  return {
    async add({ repo, prNumber, findingId, commentId, author, body }) {
      const [pull] = await db
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .where(
          and(
            sql`lower(${pullRequests.repo}) = ${repo.toLowerCase()}`,
            eq(pullRequests.number, prNumber),
          ),
        )
        .limit(1);
      if (pull === undefined) return false;
      // Redacted before it's stored: a reply can quote a credential.
      const text = redactSensitive(body.slice(0, MAX_REPLY_BODY)).text;
      const rows = await db
        .insert(pendingReplies)
        .values({
          pullRequestId: pull.id,
          findingId,
          githubCommentId: commentId,
          author,
          body: text,
        })
        .onConflictDoNothing({ target: pendingReplies.githubCommentId })
        .returning({ id: pendingReplies.id });
      return rows.length > 0;
    },
    async take(pullRequestId, limit) {
      const rows = await db
        .select()
        .from(pendingReplies)
        .where(
          and(
            eq(pendingReplies.pullRequestId, pullRequestId),
            eq(pendingReplies.status, "pending"),
          ),
        )
        .orderBy(asc(pendingReplies.createdAt));
      // Each finding's latest reply only: the earlier ones on it are answered by answering it.
      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) latest.set(row.findingId, row);
      const kept = new Set([...latest.values()].map((row) => row.id));
      const superseded = rows.filter((row) => !kept.has(row.id)).map((row) => row.id);
      if (superseded.length > 0) await finish(superseded, "skipped");
      return rows
        .filter((row) => kept.has(row.id))
        .slice(0, limit)
        .map((row): PendingReply => ({
          id: row.id,
          findingId: row.findingId,
          commentId: row.githubCommentId,
          author: row.author,
          body: row.body,
          attempts: row.attempts,
        }));
    },
    finish,
    async failed(ids) {
      if (ids.length === 0) return;
      await db
        .update(pendingReplies)
        .set({
          attempts: sql`${pendingReplies.attempts} + 1`,
          status: sql`case when ${pendingReplies.attempts} + 1 >= ${MAX_JUDGE_ATTEMPTS} then 'skipped'::pending_reply_status else ${pendingReplies.status} end`,
          updatedAt: now(),
        })
        .where(and(inArray(pendingReplies.id, [...ids]), eq(pendingReplies.status, "pending")));
    },
  };
}
