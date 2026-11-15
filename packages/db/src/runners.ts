import { eq, sql } from "drizzle-orm";
import { localRunners } from "./schema.js";
import type { Database } from "./usage.js";

/**
 * Several docker compose runners at once (NIC-1056). Each runner process registers in
 * `local_runners` at start and beats every few seconds; one whose heartbeat is stale has stopped,
 * and only then are its executions and sandboxes another runner's to clean up. Times are the
 * database's, so the hosts' clocks don't matter. Unused on AWS.
 */

/** Rows from a raw query, from node-postgres and PGlite alike. */
async function rows<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

const since = (staleMs: number) => sql`now() - make_interval(secs => ${staleMs / 1000})`;

export function postgresRunners(db: Database) {
  const beat = async (id: string, host: string) => {
    await db
      .insert(localRunners)
      .values({ id, host })
      .onConflictDoUpdate({ target: localRunners.id, set: { lastSeen: sql`now()` } });
  };
  return {
    /** Registers runner `id`, alive now. */
    register: beat,
    /**
     * Marks `id` alive now. A runner whose row was pruned while it couldn't reach the database
     * gets it back.
     */
    heartbeat: (id: string, host: string) => beat(id, host),
    /** The runners with a heartbeat in the last `staleMs`. */
    async live(staleMs: number): Promise<Set<string>> {
      const found = await db
        .select({ id: localRunners.id })
        .from(localRunners)
        .where(sql`${localRunners.lastSeen} > ${since(staleMs)}`);
      return new Set(found.map((row) => row.id));
    },
    /** A runner that stopped cleanly: its row goes. */
    async remove(id: string): Promise<void> {
      await db.delete(localRunners).where(eq(localRunners.id, id));
    },
    /** Deletes the stale runners that no longer own a running execution. */
    async pruneStale(staleMs: number): Promise<number> {
      const deleted = await rows<{ id: string }>(
        db,
        sql`
          delete from local_runners r
          where r.last_seen <= ${since(staleMs)}
            and not exists (
              select 1 from local_executions e where e.owner = r.id and e.status = 'RUNNING'
            )
          returning r.id`,
      );
      return deleted.length;
    },
  };
}

export type PostgresRunners = ReturnType<typeof postgresRunners>;

/** One connection of a pool, as `runExclusive` uses it (`pg.PoolClient`). */
export interface LockClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean | Error): void;
}

/**
 * Runs a scheduled job on one runner at a time (NIC-1056): behind `pg_try_advisory_lock`, held
 * on one connection while `task` runs, and only when the job hasn't run in the last `minGapMs`
 * (`local_schedules`), so several runners, each running the job on its own timer, run it about
 * once per interval between them. Returns whether it ran here. The lock is a session lock: if the
 * runner dies, Postgres drops it with the connection.
 */
export async function runExclusive(
  pool: { connect(): Promise<LockClient> },
  name: string,
  minGapMs: number,
  task: () => Promise<unknown>,
): Promise<boolean> {
  const key = `lgtmoose:schedule:${name}`;
  const client = await pool.connect();
  let broken = false;
  try {
    const lock = await client.query(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
      [key],
    );
    if (lock.rows[0]?.locked !== true) return false;
    try {
      const due = await client.query(
        `insert into local_schedules (name, last_run_at) values ($1, now())
         on conflict (name) do update set last_run_at = now()
         where local_schedules.last_run_at <= now() - make_interval(secs => $2::float8)
         returning name`,
        [name, minGapMs / 1000],
      );
      if (due.rows.length === 0) return false;
      await task();
      return true;
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch {
        // Destroying the connection drops the lock with it.
        broken = true;
      }
    }
  } finally {
    client.release(broken);
  }
}
