import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import type { ReviewEvent } from "@lgtmoose/core";
import { filesReviewed, findingEvents, findings, pullRequests, reviewRuns } from "@lgtmoose/db";
import { cloneAtSha, githubCloneUrl } from "@lgtmoose/git";
import { githubPullReader } from "@lgtmoose/pipeline";
import {
  GitHubClient,
  GitHubLabelClient,
  GitHubPoster,
  ShadowPoster,
  installationTokenProvider,
} from "@lgtmoose/poster";
import { and, asc, desc, eq, gt, inArray, max, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { z } from "zod";
import type { ControlEnv } from "./env.js";
import type {
  ArtifactStore,
  ControlDeps,
  FindingStore,
  RunRecord,
  RunStore,
  TaskTokens,
} from "./ports.js";

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
        if (error instanceof Error && error.name === "NoSuchKey") return undefined;
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

const REVIEW_EVENTS: readonly ReviewEvent[] = ["APPROVE", "COMMENT", "REQUEST_CHANGES"];

/** `review_runs` and `pull_requests` with drizzle. */
export function drizzleRunStore(db: Db, now: () => Date = () => new Date()): RunStore {
  async function record(runId: string): Promise<RunRecord | undefined> {
    const [row] = await db
      .select({
        runId: reviewRuns.id,
        pullRequestId: reviewRuns.pullRequestId,
        summaryCommentId: pullRequests.summaryCommentId,
        lastReviewedSha: pullRequests.lastReviewedSha,
        statusLabel: pullRequests.statusLabel,
        lastReviewEvent: pullRequests.lastReviewEvent,
        lastReviewId: pullRequests.lastReviewId,
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
          lastReviewedSha: row.lastReviewedSha ?? undefined,
          statusLabel: row.statusLabel ?? undefined,
          lastReviewEvent: REVIEW_EVENTS.find((event) => event === row.lastReviewEvent),
          lastReviewId: row.lastReviewId ?? undefined,
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
        .returning({ id: pullRequests.id, lastReviewedSha: pullRequests.lastReviewedSha });
      if (pull === undefined) throw new Error("The pull request wasn't recorded.");
      const [run] = await db
        .insert(reviewRuns)
        .values({
          pullRequestId: pull.id,
          headSha: input.headSha,
          // Until the prepare step has diffed the PR (see `setPlan`).
          kind: pull.lastReviewedSha === null ? "first" : "incremental",
          status: "running",
          executionArn: input.executionArn,
          startedAt: now(),
        })
        .returning({ id: reviewRuns.id });
      const recorded = run === undefined ? undefined : await record(run.id);
      if (recorded === undefined) throw new Error("The review run wasn't recorded.");
      return recorded;
    },
    getRun: record,
    async setPlan(runId, plan) {
      await db
        .update(reviewRuns)
        .set({ filesTotal: plan.filesTotal, kind: plan.kind, fromSha: plan.fromSha ?? null })
        .where(eq(reviewRuns.id, runId));
    },
    async reviewedFiles(pullRequestId) {
      // The latest posted run's record of each path.
      const rows = await db
        .selectDistinctOn([filesReviewed.path], {
          path: filesReviewed.path,
          blobSha: filesReviewed.blobSha,
          baseBlobSha: filesReviewed.baseBlobSha,
          depth: filesReviewed.depth,
          reviewedAt: reviewRuns.headSha,
        })
        .from(filesReviewed)
        .innerJoin(reviewRuns, eq(filesReviewed.runId, reviewRuns.id))
        .where(and(eq(reviewRuns.pullRequestId, pullRequestId), eq(reviewRuns.status, "succeeded")))
        .orderBy(filesReviewed.path, desc(reviewRuns.createdAt), desc(filesReviewed.createdAt));
      // Runs never record "skipped"; the enum has it for files the planner left out.
      return rows.flatMap((row) =>
        row.depth === "skipped"
          ? []
          : [{ ...row, baseBlobSha: row.baseBlobSha ?? undefined, depth: row.depth }],
      );
    },
    async recordFiles(runId, files) {
      for (let i = 0; i < files.length; i += INSERT_CHUNK) {
        await db
          .insert(filesReviewed)
          .values(
            files
              .slice(i, i + INSERT_CHUNK)
              .map((file) => ({ runId, ...file, baseBlobSha: file.baseBlobSha ?? null })),
          )
          .onConflictDoNothing();
      }
    },
    async unpostedRuns(pullRequestId, exceptRunId, limit) {
      const [posted] = await db
        .select({ at: max(reviewRuns.createdAt) })
        .from(reviewRuns)
        .where(
          and(eq(reviewRuns.pullRequestId, pullRequestId), eq(reviewRuns.status, "succeeded")),
        );
      const since = posted?.at ?? undefined;
      const rows = await db
        .select({ id: reviewRuns.id })
        .from(reviewRuns)
        .where(
          and(
            eq(reviewRuns.pullRequestId, pullRequestId),
            ne(reviewRuns.id, exceptRunId),
            ne(reviewRuns.status, "succeeded"),
            ...(since === undefined ? [] : [gt(reviewRuns.createdAt, since)]),
          ),
        )
        .orderBy(desc(reviewRuns.createdAt))
        .limit(limit);
      return rows.map((row) => row.id);
    },
    async succeedRun(runId, result) {
      const run = await record(runId);
      if (run === undefined) throw new Error(`No review run ${runId}.`);
      await db.transaction(async (tx) => {
        await tx
          .update(reviewRuns)
          .set({
            status: "succeeded",
            filesDone: result.filesDone,
            costUsd: result.costUsd === undefined ? null : result.costUsd.toFixed(4),
            finishedAt: now(),
          })
          .where(eq(reviewRuns.id, runId));
        await tx
          .update(pullRequests)
          .set({
            lastReviewedSha: result.reviewedSha,
            ...(result.review === undefined
              ? {}
              : { lastReviewEvent: result.review.event, lastReviewId: result.review.id ?? null }),
            statusLabel: result.statusLabel ?? null,
            summaryCommentId: result.summaryCommentId ?? null,
            updatedAt: now(),
          })
          .where(eq(pullRequests.id, run.pullRequestId));
      });
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
      await db
        .update(reviewRuns)
        .set({ status: "superseded", finishedAt: now() })
        .where(eq(reviewRuns.id, runId));
    },
  };
}

/** Rows per insert, to stay well under Postgres's limit on bound parameters. */
const INSERT_CHUNK = 500;

/** Our own findings in `findings`, with a `finding_events` row for each change. */
export function drizzleFindingStore(db: Db, now: () => Date = () => new Date()): FindingStore {
  return {
    async trackedFindings(pullRequestId) {
      const rows = await db
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.pullRequestId, pullRequestId),
            inArray(findings.status, ["open", "outdated"]),
            eq(findings.source, "self"),
          ),
        )
        .orderBy(asc(findings.createdAt));
      return rows.flatMap((row) =>
        row.path === null ||
        row.line === null ||
        row.side === null ||
        (row.status !== "open" && row.status !== "outdated")
          ? []
          : [
              {
                id: row.id,
                fingerprint: row.fingerprint,
                ruleCategory: row.ruleCategory,
                severity: row.severity,
                path: row.path,
                line: row.line,
                startLine: row.startLine ?? undefined,
                side: row.side,
                title: row.title,
                body: row.body,
                raisedAtSha: row.raisedAtSha,
                status: row.status,
              },
            ],
      );
    },
    async saveFindings(pullRequestId, runId, headSha, posted) {
      if (posted.length === 0) return;
      await db.transaction(async (tx) => {
        for (let i = 0; i < posted.length; i += INSERT_CHUNK) {
          const rows = await tx
            .insert(findings)
            .values(
              posted.slice(i, i + INSERT_CHUNK).map(({ finding, fingerprint }) => ({
                pullRequestId,
                runId,
                fingerprint,
                ruleCategory: finding.rule_category,
                severity: finding.severity,
                path: finding.path,
                line: finding.line,
                startLine: finding.start_line ?? null,
                side: finding.side,
                title: finding.title,
                body: finding.body,
                raisedAtSha: headSha,
              })),
            )
            .onConflictDoUpdate({
              target: [findings.pullRequestId, findings.fingerprint],
              set: {
                runId,
                severity: sql`excluded.severity`,
                path: sql`excluded.path`,
                line: sql`excluded.line`,
                startLine: sql`excluded.start_line`,
                side: sql`excluded.side`,
                title: sql`excluded.title`,
                body: sql`excluded.body`,
                raisedAtSha: headSha,
                status: "open",
                updatedAt: now(),
              },
              // A finding someone declined, disputed or resolved stays that way.
              setWhere: inArray(findings.status, ["open", "outdated", "fixed", "cleared"]),
            })
            .returning({ id: findings.id });
          // Every row may have hit a declined, disputed or resolved finding, left as it was.
          if (rows.length === 0) continue;
          await tx.insert(findingEvents).values(
            rows.map((row) => ({
              findingId: row.id,
              type: "raised" as const,
              actor: "self",
              sha: headSha,
            })),
          );
        }
      });
    },
    markOutdated: (ids, sha) => moveStatus(ids, "open", "outdated", "outdated", sha),
    reopen: (ids, sha) => moveStatus(ids, "outdated", "open", "raised", sha),
    markCleared: (ids, sha) => moveStatus(ids, "open", "cleared", "cleared", sha),
  };

  /** Moves findings still in status `from` to `to`, with an event for each one that moved. */
  async function moveStatus(
    ids: readonly string[],
    from: "open" | "outdated",
    to: "open" | "outdated" | "cleared",
    event: "outdated" | "raised" | "cleared",
    sha: string,
  ): Promise<void> {
    if (ids.length === 0) return;
    await db.transaction(async (tx) => {
      for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
        const rows = await tx
          .update(findings)
          .set({ status: to, updatedAt: now() })
          .where(
            and(inArray(findings.id, ids.slice(i, i + INSERT_CHUNK)), eq(findings.status, from)),
          )
          .returning({ id: findings.id });
        if (rows.length === 0) continue;
        await tx
          .insert(findingEvents)
          .values(rows.map((row) => ({ findingId: row.id, type: event, actor: "self", sha })));
      }
    });
  }
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
  const db = drizzle({ client: pool });

  return {
    store,
    runs: drizzleRunStore(db),
    findings: drizzleFindingStore(db),
    tokens: sfnTaskTokens(new SFNClient({})),
    async github(installationId) {
      const token = installationTokenProvider({
        appId: app.appId,
        privateKey: app.privateKey,
        installationId,
      });
      const client = new GitHubClient({ token });
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
            : new GitHubPoster(client),
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
