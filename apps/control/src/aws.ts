import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { pullRequests, reviewRuns } from "@lgtmoose/db";
import { cloneAtSha, githubCloneUrl } from "@lgtmoose/git";
import { githubPullReader } from "@lgtmoose/pipeline";
import {
  GitHubClient,
  GitHubLabelClient,
  GitHubPoster,
  ShadowPoster,
  installationTokenProvider,
  appJwt,
} from "@lgtmoose/poster";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { z } from "zod";
import type { ControlEnv } from "./env.js";
import { errorName } from "./sfn.js";
import type { ArtifactStore, ControlDeps, RunRecord, RunStore, TaskTokens } from "./ports.js";

/** Longest a GitHub request may take: well under the post step's 5-minute heartbeat timeout. */
export const GITHUB_TIMEOUT_MS = 60_000;

/**
 * A conditional PutObject: the new ETag, or undefined when the condition failed (412). A 409
 * (another conditional write of the key in flight) throws, for the caller to retry.
 *
 * A 412 can also answer the SDK's own retry of a write S3 already applied. So on a 412 the
 * object is read back: if it holds exactly our body, the write was ours. Callers make bodies
 * unique to the writer (an attempt ID, a write count), so another writer's can't match.
 */
async function conditionalPut(
  client: Pick<S3Client, "send">,
  input: { Bucket: string; Key: string; Body: string; IfNoneMatch?: string; IfMatch?: string },
): Promise<string | undefined> {
  try {
    const reply = await client.send(
      new PutObjectCommand({ ...input, ContentType: "application/json" }),
    );
    if (reply.ETag === undefined) throw new Error(`S3 returned no ETag for ${input.Key}.`);
    return reply.ETag;
  } catch (error) {
    if (errorName(error) !== "PreconditionFailed") throw error;
    const stored = await getTagged(client, input.Bucket, input.Key);
    return stored?.text === input.Body ? stored.etag : undefined;
  }
}

async function getTagged(
  client: Pick<S3Client, "send">,
  bucket: string,
  key: string,
): Promise<{ text: string; etag: string } | undefined> {
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (object.ETag === undefined) throw new Error(`S3 returned no ETag for ${key}.`);
    return { text: (await object.Body?.transformToString("utf8")) ?? "", etag: object.ETag };
  } catch (error) {
    if (errorName(error) === "NoSuchKey") return undefined;
    throw error;
  }
}

/** The artifact bucket over S3. */
export function s3ArtifactStore(client: S3Client, bucket: string): ArtifactStore {
  return {
    async putText(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
        }),
      );
    },
    async createText(key, body) {
      return conditionalPut(client, { Bucket: bucket, Key: key, Body: body, IfNoneMatch: "*" });
    },
    async replaceText(key, body, etag) {
      return conditionalPut(client, { Bucket: bucket, Key: key, Body: body, IfMatch: etag });
    },
    getTagged: (key) => getTagged(client, bucket, key),
    async deleteIfMatch(key, etag) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, IfMatch: etag }));
      } catch (error) {
        // Changed or gone since: someone else's now, or no one's.
        const name = errorName(error);
        if (name !== "PreconditionFailed" && name !== "NoSuchKey") throw error;
      }
    },
    async putFile(key, path, contentType) {
      const { size } = await stat(path);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: size,
          ContentType: contentType,
        }),
      );
    },
    async getText(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return (await object.Body?.transformToString("utf8")) ?? "";
      } catch (error) {
        if (errorName(error) === "NoSuchKey") return undefined;
        throw error;
      }
    },
  };
}

export function sfnTaskTokens(client: SFNClient): TaskTokens {
  return {
    async succeed(token, output) {
      await client.send(
        new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify(output) }),
      );
    },
    async fail(token, error, cause) {
      await client.send(new SendTaskFailureCommand({ taskToken: token, error, cause }));
    },
  };
}

async function readSecret(client: SecretsManagerClient, secretId: string): Promise<unknown> {
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!SecretString) throw new Error(`Secret ${secretId} has no string value.`);
  try {
    return JSON.parse(SecretString) as unknown;
  } catch {
    // The value is a credential: never echo it.
    throw new Error(`Secret ${secretId} isn't JSON.`);
  }
}

const appSecretSchema = z.object({
  appId: z.coerce.number().int().positive(),
  privateKey: z.string().min(1),
});

const databaseSecretSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  username: z.string().min(1),
  password: z.string().min(1),
});

function parseSecret<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  // Only the field paths: the issues could quote the values.
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`The ${what} secret is missing fields or has the wrong types: ${fields}.`);
  }
  return parsed.data;
}

/** Any drizzle Postgres database: node-postgres in the task, PGlite in tests. */
type Db = PgDatabase<PgQueryResultHKT>;

/** A run's place among its PR's runs: its event time, else when its row was made. */
const runOrder = sql<Date>`coalesce(${reviewRuns.eventAt}, ${reviewRuns.createdAt})`;

async function newerRunPosted(
  db: Pick<Db, "select">,
  run: { pullRequestId: string; order: Date },
): Promise<boolean> {
  // A run that wrote PR-level state: it succeeded, or it was covered and wrote the PR's
  // outputs. A covered run that wrote nothing doesn't count: it never stands in for the run
  // that posted.
  const [newer] = await db
    .select({ id: reviewRuns.id })
    .from(reviewRuns)
    .where(
      and(
        eq(reviewRuns.pullRequestId, run.pullRequestId),
        eq(reviewRuns.wrotePr, true),
        gt(runOrder, run.order),
      ),
    )
    .limit(1);
  return newer !== undefined;
}

/**
 * Records a posted run's outputs on its PR, unless a newer run of the PR has posted. The PR's
 * row is locked first, so two runs finishing at once take turns, and the newer-run check sees
 * the other's committed status (each statement reads afresh under READ COMMITTED).
 */
async function recordOnPr(
  tx: Pick<Db, "select" | "update">,
  run: { pullRequestId: string; order: Date },
  pr: { headSha: string; statusLabel: string | undefined; summaryCommentId: number | undefined },
  now: () => Date,
): Promise<void> {
  await tx
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(eq(pullRequests.id, run.pullRequestId))
    .for("update");
  if (await newerRunPosted(tx, run)) return;
  await tx
    .update(pullRequests)
    .set({
      lastReviewedSha: pr.headSha,
      statusLabel: pr.statusLabel ?? null,
      summaryCommentId: pr.summaryCommentId ?? null,
      updatedAt: now(),
    })
    .where(eq(pullRequests.id, run.pullRequestId));
}

/** `review_runs` and `pull_requests` with drizzle. */
export function drizzleRunStore(db: Db, now: () => Date = () => new Date()): RunStore {
  async function record(runId: string): Promise<RunRecord | undefined> {
    const [row] = await db
      .select({
        runId: reviewRuns.id,
        pullRequestId: reviewRuns.pullRequestId,
        summaryCommentId: pullRequests.summaryCommentId,
        headSha: reviewRuns.headSha,
        lastReviewedSha: pullRequests.lastReviewedSha,
        eventAt: reviewRuns.eventAt,
        createdAt: reviewRuns.createdAt,
      })
      .from(reviewRuns)
      .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
      .where(eq(reviewRuns.id, runId));
    return row === undefined
      ? undefined
      : {
          runId: row.runId,
          pullRequestId: row.pullRequestId,
          summaryCommentId: row.summaryCommentId ?? undefined,
          headSha: row.headSha,
          lastReviewedSha: row.lastReviewedSha ?? undefined,
          order: row.eventAt ?? row.createdAt,
        };
  }

  return {
    async startRun(input) {
      // A retried prepare step finds the run its first attempt recorded.
      const [existing] = await db
        .select({ id: reviewRuns.id })
        .from(reviewRuns)
        .where(eq(reviewRuns.executionArn, input.executionArn));
      if (existing !== undefined) {
        const run = await record(existing.id);
        if (run !== undefined) return run;
      }
      const [pull] = await db
        .insert(pullRequests)
        .values({
          installationId: input.installationId,
          repo: input.repo,
          number: input.number,
          author: input.author,
          headSha: input.headSha,
          baseSha: input.baseSha,
        })
        .onConflictDoUpdate({
          target: [pullRequests.repo, pullRequests.number],
          set: {
            installationId: input.installationId,
            author: input.author,
            headSha: input.headSha,
            baseSha: input.baseSha,
            updatedAt: now(),
          },
        })
        .returning({
          id: pullRequests.id,
          lastReviewedSha: pullRequests.lastReviewedSha,
          summaryCommentId: pullRequests.summaryCommentId,
        });
      if (pull === undefined) throw new Error("The pull request wasn't recorded.");
      const [run] = await db
        .insert(reviewRuns)
        .values({
          pullRequestId: pull.id,
          headSha: input.headSha,
          // Every run reviews the whole PR until incremental reviews land.
          kind: pull.lastReviewedSha === null ? "first" : "full",
          status: "running",
          executionArn: input.executionArn,
          eventAt: input.eventAt ?? null,
          startedAt: now(),
        })
        .returning({ id: reviewRuns.id });
      const recorded = run === undefined ? undefined : await record(run.id);
      if (recorded === undefined) throw new Error("The review run wasn't recorded.");
      return recorded;
    },
    getRun: record,
    async setFilesTotal(runId, filesTotal) {
      await db.update(reviewRuns).set({ filesTotal }).where(eq(reviewRuns.id, runId));
    },
    async succeedRun(runId, result) {
      await db.transaction(async (tx) => {
        // It posted, so it succeeded, even if it was superseded or failed while posting.
        const [run] = await tx
          .update(reviewRuns)
          .set({
            status: "succeeded",
            wrotePr: true,
            filesDone: result.filesDone,
            costUsd: result.costUsd === undefined ? null : result.costUsd.toFixed(4),
            finishedAt: now(),
          })
          .where(eq(reviewRuns.id, runId))
          .returning({ pullRequestId: reviewRuns.pullRequestId, order: runOrder });
        if (run === undefined) throw new Error(`No review run ${runId}.`);
        // The PR's record is the newest posted run's: an older run that finished posting later
        // (stopped mid-post, say) leaves it to the newer one.
        await recordOnPr(tx, run, result, now);
      });
    },
    async coverRun(runId, result) {
      await db.transaction(async (tx) => {
        const [run] = await tx
          .update(reviewRuns)
          .set({
            status: "covered",
            // Once set, kept: a later call without `pr` (a retry) doesn't undo what was written.
            ...(result.pr === undefined ? {} : { wrotePr: true }),
            filesDone: result.filesDone,
            costUsd: result.costUsd === undefined ? null : result.costUsd.toFixed(4),
            finishedAt: now(),
          })
          .where(eq(reviewRuns.id, runId))
          .returning({ pullRequestId: reviewRuns.pullRequestId, order: runOrder });
        if (run === undefined) throw new Error(`No review run ${runId}.`);
        if (result.pr !== undefined) await recordOnPr(tx, run, result.pr, now);
      });
    },
    async newerRunPosted(run) {
      return newerRunPosted(db, run);
    },
    async failRun(executionArn, error) {
      // A run that already finished (or was superseded) keeps its status.
      await db
        .update(reviewRuns)
        .set({ status: "failed", error, finishedAt: now() })
        .where(
          and(
            eq(reviewRuns.executionArn, executionArn),
            inArray(reviewRuns.status, ["queued", "running"]),
          ),
        );
    },
    async supersedeRun(runId) {
      // A run that already finished (or failed) keeps its status.
      await db
        .update(reviewRuns)
        .set({ status: "superseded", finishedAt: now() })
        .where(and(eq(reviewRuns.id, runId), inArray(reviewRuns.status, ["queued", "running"])));
    },
  };
}

/** Writes a gzip tarball of `dir`, hidden files included. */
export function tarArchive(dir: string, archive: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", archive, "-C", dir, "."], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2000) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ message, ...fields })}\n`);
}

/**
 * The control task's real dependencies: S3, Step Functions, the database and GitHub as the App.
 * `close` ends the database pool.
 */
export async function awsControlDeps(
  env: ControlEnv,
  options: { shadow: boolean },
): Promise<ControlDeps & { close(): Promise<void> }> {
  const secrets = new SecretsManagerClient({});
  const app = parseSecret(
    appSecretSchema,
    await readSecret(secrets, env.githubAppSecretArn),
    "GitHub App",
  );
  const database = parseSecret(
    databaseSecretSchema,
    await readSecret(secrets, env.databaseSecretArn),
    "database",
  );
  const pool = new pg.Pool({
    host: database.host,
    port: database.port,
    user: database.username,
    password: database.password,
    database: env.databaseName,
    ssl: { rejectUnauthorized: true },
    max: 2,
  });
  const store = s3ArtifactStore(new S3Client({}), env.artifactBucket);
  // The App's slug, read once with the App's own JWT.
  let slugOnce: Promise<string> | undefined;
  const slug = () => {
    slugOnce ??= new GitHubClient({
      token: async () => appJwt(app.appId, app.privateKey),
      timeoutMs: GITHUB_TIMEOUT_MS,
    })
      .request<{ slug?: unknown }>("GET", "/app")
      .then((reply) => {
        if (typeof reply.slug !== "string") throw new Error("GET /app returned no slug.");
        return reply.slug;
      });
    slugOnce.catch(() => {
      slugOnce = undefined;
    });
    return slugOnce;
  };

  return {
    store,
    runs: drizzleRunStore(drizzle({ client: pool })),
    tokens: sfnTaskTokens(new SFNClient({})),
    async github(installationId) {
      const token = installationTokenProvider({
        appId: app.appId,
        privateKey: app.privateKey,
        installationId,
        timeoutMs: GITHUB_TIMEOUT_MS,
      });
      // Bounded well under the post step's heartbeat timeout: a hung write fails the attempt.
      const client = new GitHubClient({ token, timeoutMs: GITHUB_TIMEOUT_MS });
      return {
        reader: githubPullReader((path) => client.request("GET", path)),
        token,
        poster: (runId, pull) =>
          options.shadow
            ? new ShadowPoster({
                store: { put: (key, body) => store.putText(key, body) },
                runId,
                log,
                labelReader: new GitHubLabelClient(client, pull),
              })
            : new GitHubPoster(client, {
                appId: app.appId,
                // Its bot is `<slug>[bot]`: how its own reviews are told from others'.
                appSlug: slug,
              }),
      };
    },
    clone: cloneAtSha,
    cloneUrl: githubCloneUrl,
    async workDir() {
      const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lgtmoose-"));
      return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
    },
    archive: tarArchive,
    log,
    close: () => pool.end(),
  };
}
