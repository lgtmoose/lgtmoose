import { learningEvents, learnings, type Database } from "@lgtmoose/db";
import { and, asc, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { toPermission } from "./policy.js";
import type { Learning, LearningEvent, LearningStore, NewLearningEvent } from "./store.js";

type Row = typeof learnings.$inferSelect;

function toLearning(row: Row): Learning {
  return {
    id: row.id,
    org: row.org,
    repo: row.repo ?? undefined,
    pathGlob: row.pathGlob ?? undefined,
    kind: row.kind,
    category: row.category ?? undefined,
    text: row.text,
    status: row.status,
    // Every learning this package stores has one; older rows fall back to their repo.
    sourceRepo: row.sourceRepo ?? row.repo ?? row.org,
    sourcePr: row.sourcePr ?? undefined,
    sourceCommentId: row.sourceCommentId ?? undefined,
    author: row.author,
    authorPermission: toPermission(row.authorPermission),
    createdAt: row.createdAt,
    retiredAt: row.retiredAt ?? undefined,
  };
}

function eventRows(learningId: string, events: readonly NewLearningEvent[]) {
  return events.map((event) => ({
    learningId,
    type: event.type,
    actor: event.actor,
    actorPermission: event.actorPermission,
    githubCommentId: event.githubCommentId ?? null,
  }));
}

/** `LearningStore` on Postgres (`learnings`, `learning_events`). */
export function drizzleLearningStore(
  db: Database,
  now: () => Date = () => new Date(),
): LearningStore {
  return {
    async insert(learning, events) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(learnings)
          .values({
            org: learning.org,
            repo: learning.repo ?? null,
            pathGlob: learning.pathGlob ?? null,
            kind: learning.kind,
            category: learning.category ?? null,
            text: learning.text,
            status: learning.status,
            sourceRepo: learning.sourceRepo,
            sourcePr: learning.sourcePr ?? null,
            sourceCommentId: learning.sourceCommentId ?? null,
            author: learning.author,
            authorPermission: learning.authorPermission,
          })
          .onConflictDoNothing({ target: [learnings.sourceRepo, learnings.sourceCommentId] })
          .returning();
        if (row === undefined) {
          const [existing] = await tx
            .select()
            .from(learnings)
            .where(
              and(
                eq(learnings.sourceRepo, learning.sourceRepo),
                eq(learnings.sourceCommentId, learning.sourceCommentId ?? -1),
              ),
            );
          if (existing === undefined) throw new Error("A conflicting learning vanished.");
          return { learning: toLearning(existing), created: false };
        }
        if (events.length > 0) await tx.insert(learningEvents).values(eventRows(row.id, events));
        return { learning: toLearning(row), created: true };
      });
    },
    async get(id) {
      const [row] = await db.select().from(learnings).where(eq(learnings.id, id));
      return row === undefined ? undefined : toLearning(row);
    },
    async transition(id, from, to, event) {
      return db.transaction(async (tx) => {
        const at = now();
        const [row] = await tx
          .update(learnings)
          .set({ status: to, updatedAt: at, ...(to === "retired" ? { retiredAt: at } : {}) })
          .where(and(eq(learnings.id, id), inArray(learnings.status, [...from])))
          .returning();
        if (row === undefined) return undefined;
        await tx.insert(learningEvents).values(eventRows(id, [event]));
        return toLearning(row);
      });
    },
    async list({ org, repo, status }) {
      const where: SQL[] = [eq(learnings.org, org)];
      if (repo !== undefined) {
        const either = or(eq(learnings.repo, repo), isNull(learnings.repo));
        if (either !== undefined) where.push(either);
      }
      if (status !== undefined) where.push(eq(learnings.status, status));
      const rows = await db
        .select()
        .from(learnings)
        .where(and(...where))
        .orderBy(desc(learnings.createdAt), desc(learnings.id));
      return rows.map(toLearning);
    },
    async events(learningId) {
      const rows = await db
        .select()
        .from(learningEvents)
        .where(eq(learningEvents.learningId, learningId))
        .orderBy(asc(learningEvents.seq));
      return rows.map((row): LearningEvent => ({
        learningId: row.learningId,
        type: row.type,
        actor: row.actor,
        actorPermission: toPermission(row.actorPermission),
        githubCommentId: row.githubCommentId ?? undefined,
        createdAt: row.createdAt,
      }));
    },
  };
}
