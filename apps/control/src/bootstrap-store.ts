import { learningBootstrapItems, learningBootstraps, type BootstrapSource } from "@lgtmoose/db";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "./database.js";

/**
 * `learning_bootstraps` and `learning_bootstrap_items` (NIC-1080): the bootstraps people asked
 * for, and the pending learnings each proposed with the comments they rest on.
 */

export type BootstrapStatus = "requested" | "running" | "done" | "failed";

export interface Bootstrap {
  id: string;
  /** owner/name, lower case. */
  repo: string;
  requestedBy: string;
  status: BootstrapStatus;
  maxPrs: number;
  maxCostUsd: number;
  beforePr: number | undefined;
  oldestPrRead: number | undefined;
  prsRead: number;
  commentsRead: number;
  proposed: number;
  costUsd: number;
  capped: boolean;
  executionArn: string | undefined;
  error: string | undefined;
  createdAt: Date;
  finishedAt: Date | undefined;
}

export interface BootstrapRequest {
  repo: string;
  requestedBy: string;
  maxPrs: number;
  maxCostUsd: number;
  /** Carry on below the oldest PR the repository's last finished bootstrap read. */
  resume?: boolean;
}

export type RequestResult =
  { created: true; bootstrap: Bootstrap } | { created: false; active: Bootstrap };

export interface BootstrapStore {
  get(id: string): Promise<Bootstrap | undefined>;
  /** Asks for a bootstrap, unless one is requested or running for the repository. */
  request(input: BootstrapRequest): Promise<RequestResult>;
  /** Requested bootstraps, oldest first. */
  requested(limit: number): Promise<Bootstrap[]>;
  /** Marks a requested bootstrap running with its execution; false when it wasn't requested. */
  start(id: string, executionArn: string): Promise<boolean>;
  /** What the prepare step read. */
  progress(
    id: string,
    read: {
      prsRead: number;
      commentsRead: number;
      oldestPrRead: number | undefined;
      capped: boolean;
    },
  ): Promise<void>;
  finish(id: string, result: { proposed: number; costUsd: number }): Promise<void>;
  /** Fails a requested or running bootstrap. */
  fail(id: string, error: string): Promise<void>;
  /** Fails the running bootstrap of an execution, if it is one (the workflow's failure path). */
  failByExecution(executionArn: string, error: string): Promise<boolean>;
  /** Fails bootstraps running since before `before`: their execution was lost. */
  failStale(before: Date): Promise<number>;
  /** Records a learning the bootstrap proposed, with its sources. */
  addItem(
    bootstrapId: string,
    learningId: string,
    sources: readonly BootstrapSource[],
  ): Promise<void>;
  /** The newest bootstraps of `repos`, at most `limit`. */
  recent(repos: readonly string[], limit: number): Promise<Bootstrap[]>;
  /** The items of a bootstrap, or of every bootstrap of `repos`: learning IDs and sources. */
  items(filter: {
    bootstrapId?: string;
    repos?: readonly string[];
  }): Promise<{ bootstrapId: string; learningId: string; sources: BootstrapSource[] }[]>;
}

type Row = typeof learningBootstraps.$inferSelect;

function toBootstrap(row: Row): Bootstrap {
  return {
    id: row.id,
    repo: row.repo,
    requestedBy: row.requestedBy,
    status: row.status,
    maxPrs: row.maxPrs,
    maxCostUsd: Number(row.maxCostUsd),
    beforePr: row.beforePr ?? undefined,
    oldestPrRead: row.oldestPrRead ?? undefined,
    prsRead: row.prsRead,
    commentsRead: row.commentsRead,
    proposed: row.proposed,
    costUsd: Number(row.costUsd),
    capped: row.capped,
    executionArn: row.executionArn ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt ?? undefined,
  };
}

const ACTIVE = ["requested", "running"] as const;
const MAX_ERROR = 500;
const clip = (error: string) =>
  error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR - 1)}…` : error;

export function drizzleBootstrapStore(db: Db, now: () => Date = () => new Date()): BootstrapStore {
  async function get(id: string): Promise<Bootstrap | undefined> {
    const [row] = await db.select().from(learningBootstraps).where(eq(learningBootstraps.id, id));
    return row === undefined ? undefined : toBootstrap(row);
  }
  async function active(repo: string): Promise<Bootstrap | undefined> {
    const [row] = await db
      .select()
      .from(learningBootstraps)
      .where(
        and(eq(learningBootstraps.repo, repo), inArray(learningBootstraps.status, [...ACTIVE])),
      );
    return row === undefined ? undefined : toBootstrap(row);
  }
  return {
    get,
    async request(input) {
      const repo = input.repo.trim().toLowerCase();
      let beforePr: number | undefined;
      if (input.resume === true) {
        const [last] = await db
          .select({ oldest: learningBootstraps.oldestPrRead })
          .from(learningBootstraps)
          .where(and(eq(learningBootstraps.repo, repo), eq(learningBootstraps.status, "done")))
          .orderBy(desc(learningBootstraps.createdAt))
          .limit(1);
        beforePr = last?.oldest ?? undefined;
      }
      // The partial unique index keeps it to one active bootstrap per repository, also when two
      // people ask at once.
      const [row] = await db
        .insert(learningBootstraps)
        .values({
          repo,
          requestedBy: input.requestedBy,
          maxPrs: input.maxPrs,
          maxCostUsd: input.maxCostUsd.toFixed(4),
          beforePr: beforePr ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (row !== undefined) return { created: true, bootstrap: toBootstrap(row) };
      const existing = await active(repo);
      if (existing === undefined) throw new Error("A conflicting bootstrap vanished.");
      return { created: false, active: existing };
    },
    async requested(limit) {
      const rows = await db
        .select()
        .from(learningBootstraps)
        .where(eq(learningBootstraps.status, "requested"))
        .orderBy(learningBootstraps.createdAt)
        .limit(limit);
      return rows.map(toBootstrap);
    },
    async start(id, executionArn) {
      const rows = await db
        .update(learningBootstraps)
        .set({ status: "running", executionArn, updatedAt: now() })
        .where(and(eq(learningBootstraps.id, id), eq(learningBootstraps.status, "requested")))
        .returning({ id: learningBootstraps.id });
      return rows.length > 0;
    },
    async progress(id, read) {
      await db
        .update(learningBootstraps)
        .set({
          prsRead: read.prsRead,
          commentsRead: read.commentsRead,
          oldestPrRead: read.oldestPrRead ?? null,
          capped: read.capped,
          updatedAt: now(),
        })
        .where(eq(learningBootstraps.id, id));
    },
    async finish(id, result) {
      await db
        .update(learningBootstraps)
        .set({
          status: "done",
          proposed: result.proposed,
          costUsd: result.costUsd.toFixed(4),
          finishedAt: now(),
          updatedAt: now(),
        })
        .where(and(eq(learningBootstraps.id, id), inArray(learningBootstraps.status, [...ACTIVE])));
    },
    async fail(id, error) {
      await db
        .update(learningBootstraps)
        .set({ status: "failed", error: clip(error), finishedAt: now(), updatedAt: now() })
        .where(and(eq(learningBootstraps.id, id), inArray(learningBootstraps.status, [...ACTIVE])));
    },
    async failByExecution(executionArn, error) {
      const rows = await db
        .update(learningBootstraps)
        .set({ status: "failed", error: clip(error), finishedAt: now(), updatedAt: now() })
        .where(
          and(
            eq(learningBootstraps.executionArn, executionArn),
            eq(learningBootstraps.status, "running"),
          ),
        )
        .returning({ id: learningBootstraps.id });
      return rows.length > 0;
    },
    async failStale(before) {
      const rows = await db
        .update(learningBootstraps)
        .set({
          status: "failed",
          error: "its execution didn't finish",
          finishedAt: now(),
          updatedAt: now(),
        })
        .where(
          and(eq(learningBootstraps.status, "running"), lt(learningBootstraps.updatedAt, before)),
        )
        .returning({ id: learningBootstraps.id });
      return rows.length;
    },
    async addItem(bootstrapId, learningId, sources) {
      await db
        .insert(learningBootstrapItems)
        .values({ bootstrapId, learningId, sources: [...sources] })
        .onConflictDoNothing();
    },
    async recent(repos, limit) {
      if (repos.length === 0) return [];
      const rows = await db
        .select()
        .from(learningBootstraps)
        .where(inArray(learningBootstraps.repo, [...repos]))
        .orderBy(desc(learningBootstraps.createdAt))
        .limit(limit);
      return rows.map(toBootstrap);
    },
    async items(filter) {
      const conditions = [];
      if (filter.bootstrapId !== undefined) {
        conditions.push(eq(learningBootstrapItems.bootstrapId, filter.bootstrapId));
      }
      if (filter.repos !== undefined) {
        if (filter.repos.length === 0) return [];
        conditions.push(
          inArray(
            learningBootstrapItems.bootstrapId,
            db
              .select({ id: learningBootstraps.id })
              .from(learningBootstraps)
              .where(inArray(learningBootstraps.repo, [...filter.repos])),
          ),
        );
      }
      const rows = await db
        .select({
          bootstrapId: learningBootstrapItems.bootstrapId,
          learningId: learningBootstrapItems.learningId,
          sources: learningBootstrapItems.sources,
        })
        .from(learningBootstrapItems)
        .where(conditions.length === 0 ? sql`true` : and(...conditions))
        .orderBy(learningBootstrapItems.createdAt);
      return rows;
    },
  };
}
