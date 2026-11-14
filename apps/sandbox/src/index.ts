import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { ClaudeCodeHarness, CodexHarness, type Harness } from "@lgtmoose/harness";
import { runSandboxBatch } from "./batch.js";
import { credentialEnv, harnessEnv } from "./credential.js";
import { readSandboxEnv } from "./env.js";

/** Writable volumes on the task; the root filesystem is read-only. */
const WORK = "/work";
const TMP = "/tmp";

function extract(archive: string, dir: string): Promise<void> {
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
      writeFile: (path, body) => writeFile(path, body),
      extract,
      harness: (transcripts): Harness =>
        env.harness === "codex"
          ? new CodexHarness({ transcripts, env: harnessVars, tmpRoot: TMP })
          : new ClaudeCodeHarness({ transcripts, env: harnessVars, tmpRoot: TMP }),
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
