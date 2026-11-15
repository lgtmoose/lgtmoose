import { learningEvents, learnings, type Database } from "@lgtmoose/db";
import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { toCheckedPermission } from "./policy.js";
import type { Learning, LearningEvent, LearningStore, NewLearningEvent } from "./store.js";

// Every column but the embedding, which only `nearest` needs: 1024 floats a row add up.
const rowColumns = Object.fromEntries(
  Object.entries(getTableColumns(learnings)).filter(([name]) => name !== "embedding"),
) as Omit<ReturnType<typeof getTableColumns<typeof learnings>>, "embedding">;

type Row = Omit<typeof learnings.$inferSelect, "embedding">;

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
    authorPermission: toCheckedPermission(row.authorPermission),
    createdAt: row.createdAt,
    retiredAt: row.retiredAt ?? undefined,
    hits: row.hits,
    lastUsedAt: row.lastUsedAt ?? undefined,
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
          .returning(rowColumns);
        if (row === undefined) {
          const [existing] = await tx
            .select(rowColumns)
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
      const [row] = await db.select(rowColumns).from(learnings).where(eq(learnings.id, id));
      return row === undefined ? undefined : toLearning(row);
    },
    async transition(id, from, to, event) {
      return db.transaction(async (tx) => {
        const at = now();
        const [row] = await tx
          .update(learnings)
          .set({ status: to, updatedAt: at, ...(to === "retired" ? { retiredAt: at } : {}) })
          .where(and(eq(learnings.id, id), inArray(learnings.status, [...from])))
          .returning(rowColumns);
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
        .select(rowColumns)
        .from(learnings)
        .where(and(...where))
        .orderBy(desc(learnings.createdAt), desc(learnings.id));
      return rows.map(toLearning);
    },
    async countPending(org, author, except) {
      const where: SQL[] = [
        eq(learnings.org, org),
        eq(learnings.status, "pending"),
        sql`lower(${learnings.author}) = lower(${author})`,
      ];
      if (except !== undefined) {
        where.push(
          sql`not (${learnings.sourceRepo} = ${except.sourceRepo} and ${learnings.sourceCommentId} is not distinct from ${except.sourceCommentId})`,
        );
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(learnings)
        .where(and(...where));
      return row?.count ?? 0;
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
        actorPermission: toCheckedPermission(row.actorPermission),
        githubCommentId: row.githubCommentId ?? undefined,
        createdAt: row.createdAt,
      }));
    },
    async missingEmbeddings(ids, model) {
      if (ids.length === 0) return [];
      const rows = await db
        .select({ id: learnings.id })
        .from(learnings)
        .where(
          and(
            inArray(learnings.id, [...ids]),
            or(
              isNull(learnings.embedding),
              isNull(learnings.embeddingModel),
              ne(learnings.embeddingModel, model),
            ),
          ),
        );
      const missing = new Set(rows.map((row) => row.id));
      return ids.filter((id) => missing.has(id));
    },
    async setEmbedding(id, model, embedding) {
      await db
        .update(learnings)
        .set({ embedding: [...embedding], embeddingModel: model })
        .where(eq(learnings.id, id));
    },
    async nearest(ids, model, embedding, limit) {
      if (ids.length === 0 || limit <= 0) return [];
      const distance = cosineDistance(learnings.embedding, [...embedding]);
      const rows = await db
        .select({ id: learnings.id })
        .from(learnings)
        .where(
          and(
            inArray(learnings.id, [...ids]),
            isNotNull(learnings.embedding),
            eq(learnings.embeddingModel, model),
          ),
        )
        .orderBy(distance, asc(learnings.id))
        .limit(limit);
      return rows.map((row) => row.id);
    },
    async recordUse(ids, at) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;
      await db
        .update(learnings)
        .set({ hits: sql`${learnings.hits} + 1`, lastUsedAt: at })
        .where(inArray(learnings.id, unique));
    },
    async unusedSince(before, limit) {
      const since = sql`coalesce(${learnings.lastUsedAt}, ${learnings.createdAt})`;
      const rows = await db
        .select(rowColumns)
        .from(learnings)
        .where(
          and(eq(learnings.status, "active"), sql`${since} < ${before.toISOString()}::timestamptz`),
        )
        .orderBy(since, asc(learnings.id))
        .limit(limit);
      return rows.map(toLearning);
    },
  };
}
