import { spawn } from "node:child_process";
import { accessSync, constants, createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  AgentSdkHarness,
  ClaudeCodeHarness,
  CodexHarness,
  CursorHarness,
  type Harness,
} from "@lgtmoose/harness";
import { runSandboxBatch } from "./batch.js";
import { dropSymlinks } from "./checkout.js";
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

/** The first executable named `name` on `path`, if any. */
function onPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
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
      dropSymlinks,
      harness: (transcripts, onAuthRefreshed): Harness => {
        const options = { transcripts, env: harnessVars, tmpRoot: TMP };
        if (env.harness === "codex") return new CodexHarness({ ...options, onAuthRefreshed });
        if (env.harness === "cursor-agent") return new CursorHarness(options);
        if (env.harness === "agent-sdk") {
          // The image's pinned claude (CLAUDE_CODE_VERSION), which the SDK version tracks.
          // Never the SDK's bundled binary, whose version the policy wasn't checked against.
          const claude = onPath("claude", process.env.PATH);
          if (claude === undefined) {
            throw new Error("The agent-sdk harness needs the image's claude on PATH.");
          }
          return new AgentSdkHarness({ ...options, binaryPath: claude });
        }
        return new ClaudeCodeHarness(options);
      },
      workDir: WORK,
      ...(env.model === undefined ? {} : { model: env.model }),
      ...(env.fastModel === undefined ? {} : { fastModel: env.fastModel }),
      log,
    },
    env.batchUrls,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
