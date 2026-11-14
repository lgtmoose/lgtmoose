import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { ClaudeCodeHarness, CodexHarness, CursorHarness, type Harness } from "@lgtmoose/harness";
import { runSandboxBatch } from "./batch.js";
import { dropEscapingSymlinks } from "./checkout.js";
import { credentialEnv, harnessEnv } from "./credential.js";
import { readSandboxEnv } from "./env.js";

/** Writable volumes on the task; the root filesystem is read-only. */
const WORK = "/work";
const TMP = "/tmp";

/** Extracts the checkout, then removes the PR's symlinks that lead outside it. */
async function extract(archive: string, dir: string): Promise<void> {
  await untar(archive, dir);
  const dropped = await dropEscapingSymlinks(dir);
  if (dropped.length > 0) {
    log("removed symlinks that lead outside the checkout", {
      count: dropped.length,
      paths: dropped.slice(0, 20),
    });
  }
}

function untar(archive: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    void mkdir(dir, { recursive: true }).then(() => {
      const child = spawn("tar", ["-xzf", archive, "-C", dir, "--no-same-owner"], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`tar exited with ${code}.`)),
      );
    }, reject);
  });
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ message, ...fields })}\n`);
}

/**
 * Entry point of the sandbox task: runs the reviewer on one batch (see `runSandboxBatch`). It
 * never prints a credential or a presigned URL's signature.
 */
async function main(): Promise<void> {
  const env = readSandboxEnv(process.env);
  if ("missing" in env) {
    throw new Error(`Missing environment variables: ${env.missing.join(", ")}`);
  }
  const harnessVars = harnessEnv(
    process.env,
    credentialEnv(env.harness, env.auth, process.env.LGTMOOSE_PROVIDER_CREDENTIAL),
  );
  await runSandboxBatch(
    {
      fetch,
      writeFile: (path, body) =>
        pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), createWriteStream(path)),
      extract,
      harness: (transcripts): Harness => {
        const options = { transcripts, env: harnessVars, tmpRoot: TMP };
        if (env.harness === "codex") return new CodexHarness(options);
        if (env.harness === "cursor-agent") {
          return new CursorHarness({
            ...options,
            onRestoreError: (error) =>
              log("could not put the checkout's .cursor or .claude back", {
                error: error instanceof Error ? error.message : String(error),
              }),
          });
        }
        return new ClaudeCodeHarness(options);
      },
      workDir: WORK,
      log,
    },
    env.batchUrls,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
