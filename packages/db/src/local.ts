import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { artifacts, jobQueue, localExecutions, localRunners } from "./schema.js";
import type { Database } from "./usage.js";

/**
 * docker compose (NIC-843): Postgres stand-ins for SQS FIFO, S3 and Step Functions' executions.
 * Each keeps the guarantees the code built on the AWS services relies on, with several runners
 * at once (NIC-1056); the comments say which. Unused on AWS.
 */

/** Rows from a raw query, from node-postgres and PGlite alike. */
async function rows<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

/** A message handed to a consumer: in flight until it's acknowledged, failed or times out. */
export interface QueuedMessage {
  id: number;
  groupId: string;
  body: string;
  /** How many times it's been handed out, this time included. */
  receiveCount: number;
}

/** How long a done message is kept, so a repeat of its dedupe ID is still dropped. */
export const DEDUPE_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * A queue in `job_queue`, with SQS FIFO's guarantees:
 * - **In order per group.** A message is handed out only when no older message of its group is
 *   waiting or in flight, so a PR's jobs are handled one at a time, oldest first. Other groups go
 *   on.
 * - **At least once.** A message in flight that isn't acknowledged by the time its visibility
 *   timeout is reached (the consumer died) is handed out again. `locked_until <= now()` so a
 *   timeout of exactly now is already due: PGlite's `now()` often stays on the same millisecond
 *   for the next statement, and a strict `<` would keep that message locked.
 * - **Deduplicated.** A message with a `dedupeId` already in the queue is dropped, for as long as
 *   the first is kept (until `DEDUPE_KEEP_MS` after it's done). SQS's window is five minutes: a
 *   longer one only drops more redeliveries.
 *
 * Receivers lock rows with `FOR UPDATE SKIP LOCKED`, so several may run at once.
 */
export class PostgresQueue {
  constructor(
    private readonly db: Database,
    readonly name: string,
  ) {}

  /** Adds a message. Returns false when its `dedupeId` was already queued (and drops it). */
  async send(message: { groupId: string; dedupeId: string; body: string }): Promise<boolean> {
    const inserted = await this.db
      .insert(jobQueue)
      .values({ queue: this.name, ...message })
      .onConflictDoNothing({ target: [jobQueue.queue, jobQueue.dedupeId] })
      .returning({ id: jobQueue.id });
    return inserted.length > 0;
  }

  /**
   * Hands out up to `max` messages, each the oldest of its group, and marks them in flight for
   * `visibilityMs`.
   */
  async receive(max: number, visibilityMs: number): Promise<QueuedMessage[]> {
    const taken = await rows<{
      id: string | number;
      group_id: string;
      body: string;
      receive_count: number;
    }>(
      this.db,
      sql`
        update ${jobQueue}
        set locked_until = now() + make_interval(secs => ${visibilityMs / 1000}),
            receive_count = receive_count + 1
        where id in (
          select q.id from ${jobQueue} q
          where q.queue = ${this.name}
            and q.done_at is null
            and (q.locked_until is null or q.locked_until <= now())
            and not exists (
              select 1 from ${jobQueue} o
              where o.queue = q.queue and o.group_id = q.group_id
                and o.done_at is null and o.id < q.id
            )
          order by q.id
          limit ${max}
          for update skip locked
        )
        returning id, group_id, body, receive_count`,
    );
    return taken
      .map((row) => ({
        id: Number(row.id),
        groupId: row.group_id,
        body: row.body,
        receiveCount: Number(row.receive_count),
      }))
      .sort((a, b) => a.id - b.id);
  }

  /** The message was handled: the next of its group can go. */
  async ack(id: number): Promise<void> {
    await this.db.update(jobQueue).set({ doneAt: new Date() }).where(eq(jobQueue.id, id));
  }

  /**
   * The message failed: it's handed out again after `delayMs`, and its group waits for it, as
   * SQS FIFO does with a failed message. The delay is added to the database clock, the same
   * clock `receive` compares against, so a delay of 0 is due on the next receive.
   */
  async retryLater(id: number, delayMs: number): Promise<void> {
    await this.db
      .update(jobQueue)
      .set({ lockedUntil: sql`now() + make_interval(secs => ${delayMs / 1000})` })
      .where(and(eq(jobQueue.id, id), sql`${jobQueue.doneAt} is null`));
  }

  /**
   * Moves the message to `dead` (with why) and lets its group go on: for a message that can't
   * succeed, or that failed too often.
   */
  async deadLetter(
    message: QueuedMessage,
    dead: { readonly name: string },
    reason: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(jobQueue)
        .values({
          queue: dead.name,
          groupId: message.groupId,
          dedupeId: `${this.name}:${message.id}`,
          body: JSON.stringify({ queue: this.name, reason, body: message.body }),
        })
        .onConflictDoNothing({ target: [jobQueue.queue, jobQueue.dedupeId] });
      await tx.update(jobQueue).set({ doneAt: new Date() }).where(eq(jobQueue.id, message.id));
    });
  }

  /** Deletes messages done more than `keepMs` ago. */
  async prune(keepMs = DEDUPE_KEEP_MS): Promise<number> {
    const deleted = await this.db
      .delete(jobQueue)
      .where(
        and(
          eq(jobQueue.queue, this.name),
          sql`${jobQueue.doneAt} < ${new Date(Date.now() - keepMs)}`,
        ),
      )
      .returning({ id: jobQueue.id });
    return deleted.length;
  }
}

/**
 * The artifact store in `artifacts`, with S3's conditional writes as the post step's claims and
 * the credential leases use them (`ArtifactStore` in @lgtmoose/control). Each write sets a new
 * random ETag. A write whose condition failed still succeeds when the object already holds exactly
 * that body: it answers a retry of a write that was applied, as `conditionalPut` does on S3.
 *
 * The conditions are single SQL statements on the object's row, so they're atomic however many
 * processes write at once.
 */
export function postgresArtifactStore(db: Database) {
  const newEtag = () => `"${randomUUID()}"`;
  const current = async (key: string) => {
    const [row] = await db
      .select({ body: artifacts.body, etag: artifacts.etag })
      .from(artifacts)
      .where(eq(artifacts.key, key));
    return row;
  };
  /** For a failed condition: our own earlier write counts. */
  const ifSame = async (key: string, body: Buffer) => {
    const row = await current(key);
    return row !== undefined && Buffer.from(row.body).equals(body) ? row.etag : undefined;
  };
  const put = async (key: string, body: Buffer, contentType: string) => {
    const etag = newEtag();
    await db
      .insert(artifacts)
      .values({ key, body, etag, contentType })
      .onConflictDoUpdate({
        target: artifacts.key,
        set: { body, etag, contentType, updatedAt: new Date() },
      });
  };
  return {
    putText: (key: string, body: string) => put(key, Buffer.from(body, "utf8"), "text/plain"),
    async putFile(key: string, path: string, contentType: string) {
      await put(key, await readFile(path), contentType);
    },
    async createText(key: string, body: string): Promise<string | undefined> {
      const bytes = Buffer.from(body, "utf8");
      const [row] = await db
        .insert(artifacts)
        .values({ key, body: bytes, etag: newEtag() })
        .onConflictDoNothing({ target: artifacts.key })
        .returning({ etag: artifacts.etag });
      return row?.etag ?? (await ifSame(key, bytes));
    },
    async replaceText(key: string, body: string, etag: string): Promise<string | undefined> {
      const bytes = Buffer.from(body, "utf8");
      const [row] = await db
        .update(artifacts)
        .set({ body: bytes, etag: newEtag(), updatedAt: new Date() })
        .where(and(eq(artifacts.key, key), eq(artifacts.etag, etag)))
        .returning({ etag: artifacts.etag });
      return row?.etag ?? (await ifSame(key, bytes));
    },
    async getTagged(key: string): Promise<{ text: string; etag: string } | undefined> {
      const row = await current(key);
      return row === undefined
        ? undefined
        : { text: Buffer.from(row.body).toString("utf8"), etag: row.etag };
    },
    async deleteIfMatch(key: string, etag: string): Promise<void> {
      await db.delete(artifacts).where(and(eq(artifacts.key, key), eq(artifacts.etag, etag)));
    },
    async getText(key: string): Promise<string | undefined> {
      const row = await current(key);
      return row === undefined ? undefined : Buffer.from(row.body).toString("utf8");
    },
    /** The object's bytes and type, for the sandboxes' artifact endpoint. */
    async getObject(key: string): Promise<{ body: Buffer; contentType: string } | undefined> {
      const [row] = await db
        .select({ body: artifacts.body, contentType: artifacts.contentType })
        .from(artifacts)
        .where(eq(artifacts.key, key));
      return row === undefined
        ? undefined
        : { body: Buffer.from(row.body), contentType: row.contentType };
    },
    /** Deletes objects whose key starts with `prefix` and that weren't written since `before`. */
    async deleteOlder(prefix: string, before: Date): Promise<number> {
      const deleted = await db
        .delete(artifacts)
        .where(
          and(
            sql`starts_with(${artifacts.key}, ${prefix})`,
            sql`${artifacts.updatedAt} < ${before}`,
          ),
        )
        .returning({ key: artifacts.key });
      return deleted.length;
    },
  };
}

export type PostgresArtifactStore = ReturnType<typeof postgresArtifactStore>;

/** A review workflow execution, as the local runner keeps it. */
export interface LocalExecution {
  arn: string;
  name: string;
  input: unknown;
  status: string;
  owner: string | undefined;
}

/** `local:execution:<name>`: what Step Functions' execution ARN is locally. */
export function localExecutionArn(name: string): string {
  return `local:execution:${name}`;
}

/**
 * Step Functions' executions in `local_executions`, by name: a name is used once, and starting
 * it again with the same input while it runs returns it (as `StartExecution` does), so a
 * redelivered job starts nothing new.
 */
export function postgresExecutions(db: Database) {
  const read = async (arn: string): Promise<LocalExecution | undefined> => {
    const [row] = await db.select().from(localExecutions).where(eq(localExecutions.arn, arn));
    return row === undefined
      ? undefined
      : {
          arn: row.arn,
          name: row.name,
          input: row.input,
          status: row.status,
          owner: row.owner ?? undefined,
        };
  };
  return {
    arnOf: localExecutionArn,
    async start(name: string, input: unknown): Promise<{ started: boolean }> {
      const arn = localExecutionArn(name);
      const inserted = await db
        .insert(localExecutions)
        .values({ arn, name, input, status: "RUNNING" })
        .onConflictDoNothing()
        .returning({ arn: localExecutions.arn });
      if (inserted.length > 0) return { started: true };
      const existing = await read(arn);
      const same =
        existing?.status === "RUNNING" && JSON.stringify(existing.input) === JSON.stringify(input);
      return { started: same };
    },
    async status(arn: string): Promise<string | undefined> {
      return (await read(arn))?.status;
    },
    /** Stops a running execution; one that has ended, or never started, is left as it is. */
    async stop(arn: string, cause: string): Promise<void> {
      await db
        .update(localExecutions)
        .set({ status: "ABORTED", cause, updatedAt: new Date() })
        .where(and(eq(localExecutions.arn, arn), eq(localExecutions.status, "RUNNING")));
    },
    get: read,
    /** Takes up to `max` running executions nobody runs yet, for `owner`. */
    async claim(owner: string, max: number): Promise<LocalExecution[]> {
      const taken = await rows<{ arn: string }>(
        db,
        sql`
          update ${localExecutions} set owner = ${owner}, updated_at = now()
          where arn in (
            select arn from ${localExecutions}
            where status = 'RUNNING' and owner is null
            order by created_at
            limit ${max}
            for update skip locked
          )
          returning arn`,
      );
      const found = await Promise.all(taken.map((row) => read(row.arn)));
      return found.filter((execution): execution is LocalExecution => execution !== undefined);
    },
    /**
     * Takes the running executions whose runner has stopped, for `owner` to fail, as a lost ECS
     * task fails its step: those owned by a runner with no heartbeat in the last `staleMs` (or
     * no row at all). A live runner's are never taken, and two runners recovering at once never
     * take the same one. If `owner` stops before failing them, they're its own, and recovered
     * once its heartbeat is stale in turn.
     */
    async takeOrphans(
      owner: string,
      staleMs: number,
    ): Promise<{ arn: string; previousOwner: string }[]> {
      const taken = await rows<{ arn: string; previous_owner: string }>(
        db,
        sql`
          update ${localExecutions} x set owner = ${owner}, updated_at = now()
          from (
            select e.arn, e.owner from ${localExecutions} e
            where e.status = 'RUNNING'
              and e.owner is not null
              and e.owner <> ${owner}
              and not exists (
                select 1 from ${localRunners} r
                where r.id = e.owner
                  and r.last_seen > now() - make_interval(secs => ${staleMs / 1000})
              )
          ) stale
          -- Compare and set on the owner: a run another runner took meanwhile has a new owner
          -- when this update gets its row, so it's left alone. (A row lock with SKIP LOCKED
          -- isn't enough: its recheck doesn't look at local_runners again.)
          where x.arn = stale.arn and x.owner = stale.owner and x.status = 'RUNNING'
          returning x.arn, stale.owner as previous_owner`,
      );
      return taken.map((row) => ({ arn: row.arn, previousOwner: row.previous_owner }));
    },
    /** Deletes executions that ended before `before` (the retention sweep). */
    async pruneEnded(before: Date): Promise<number> {
      const deleted = await db
        .delete(localExecutions)
        .where(
          and(
            sql`${localExecutions.status} <> 'RUNNING'`,
            sql`${localExecutions.updatedAt} < ${before}`,
          ),
        )
        .returning({ arn: localExecutions.arn });
      return deleted.length;
    },
    /** Ends a running execution: SUCCEEDED or FAILED. One stopped meanwhile stays ABORTED. */
    async finish(arn: string, status: "SUCCEEDED" | "FAILED", cause?: string): Promise<void> {
      await db
        .update(localExecutions)
        .set({ status, cause: cause ?? null, owner: null, updatedAt: new Date() })
        .where(and(eq(localExecutions.arn, arn), eq(localExecutions.status, "RUNNING")));
    },
  };
}

export type PostgresExecutions = ReturnType<typeof postgresExecutions>;
