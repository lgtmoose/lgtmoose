import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { cloneAtSha, githubCloneUrl } from "@lgtmoose/git";
import { githubPullReader } from "@lgtmoose/pipeline";
import {
  GitHubClient,
  GitHubLabelClient,
  GitHubPoster,
  ShadowPoster,
  installationTokenProvider,
} from "@lgtmoose/poster";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { databasePool, parseSecret, readSecret } from "./database.js";
import type { ControlEnv } from "./env.js";
import type { ArtifactStore, ControlDeps, TaskTokens } from "./ports.js";
import { drizzleRunStore } from "./run-store.js";

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

const appSecretSchema = z.object({
  appId: z.coerce.number().int().positive(),
  privateKey: z.string().min(1),
});

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
  const pool = await databasePool(secrets, env.databaseSecretArn, env.databaseName, 2);
  const store = s3ArtifactStore(new S3Client({}), env.artifactBucket);

  return {
    store,
    runs: drizzleRunStore(drizzle({ client: pool })),
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
