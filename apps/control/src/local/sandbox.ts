import { randomBytes } from "node:crypto";
import { runKeys, wantsFallback } from "@lgtmoose/pipeline";
import {
  acquireLease,
  CredentialBusyError,
  releaseLease,
  type BrokerDeps,
  type CredentialSecrets,
  type HeldLease,
} from "../credentials.js";
import { presignBatch } from "../presign.js";
import type { Docker } from "./docker.js";
import { readTar, writeTar } from "./tar.js";
import type { BatchRunner } from "./workflow.js";

/**
 * Runs each batch in its own sandbox container (NIC-843), as the review state machine runs a
 * Fargate task per batch on AWS: Lease → Presign → Review → Release on each provider in order,
 * moving on to the next on the same failures as on AWS (`wantsFallback`).
 *
 * The container gets only its batch: the runner writes the batch's URL set with local URLs
 * (`presignBatch`, with `LOCAL_BATCH_ORIGIN`), copies those objects into the container's own
 * volume before it starts, and copies back what it wrote once it stops. It has no socket, no
 * host path, no GitHub token, and only its provider's credential, on a network whose only other
 * member is the egress proxy.
 */

/** What the sandbox's local I/O treats as its batch's URLs (apps/sandbox `local-io.ts`). */
export const LOCAL_BATCH_ORIGIN = "https://batch.invalid";
/** Every sandbox's label. */
export const SANDBOX_LABEL = "lgtmoose.sandbox";
/** The runner that started a sandbox (NIC-1056). */
export const RUNNER_LABEL = "lgtmoose.runner";

/**
 * Removes the sandboxes a stopped runner left behind: those labelled with `runnerId` or with a
 * runner that isn't `live`. A sandbox with no runner label was started before runners were
 * labelled (NIC-1056), by a runner that has stopped since. A live runner's are never removed.
 */
export async function removeStrandedSandboxes(
  docker: Pick<Docker, "listByLabel" | "remove">,
  runnerId: string,
  live: ReadonlySet<string>,
): Promise<number> {
  let removed = 0;
  for (const container of await docker.listByLabel(`${SANDBOX_LABEL}=1`)) {
    const owner = container.labels[RUNNER_LABEL];
    if (owner !== undefined && owner !== runnerId && live.has(owner)) continue;
    await docker.remove(container.id);
    removed += 1;
  }
  return removed;
}
/** Inside the container: the batch's volume, and the directory the sandbox reads and writes. */
const BATCH_MOUNT = "/batch";
const BATCH_DIR = `${BATCH_MOUNT}/io`;
/** The sandbox image's user (infra/sandbox/Dockerfile). */
const SANDBOX_UID = 10001;
/** The most the runner takes back from one container. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** One provider a batch can run on, in fallback order. */
export interface SandboxProvider {
  id: string;
  harness: string;
  auth: string;
  /** `default` for the harness's own model. */
  model: string;
  fastModel: string;
  /** The standard tier's thinking cap. Undefined keeps the model's own thinking. */
  thinkingTokens?: number;
  /** The fast tier's thinking cap. Undefined keeps the model's own thinking. */
  fastThinkingTokens?: number;
  /** The stored credential, with how many sandboxes may hold it at once. Undefined: none. */
  credential?: { secretId: string; limit: number };
}

export interface DockerBatchDeps {
  docker: Pick<
    Docker,
    "createSandbox" | "putArchive" | "start" | "wait" | "logs" | "getArchive" | "remove"
  >;
  store: {
    getText(key: string): Promise<string | undefined>;
    putText(key: string, body: string): Promise<void>;
    getObject(key: string): Promise<{ body: Buffer } | undefined>;
  };
  secrets: CredentialSecrets;
  /** The credential broker, without the per-deployment parts this fills in. */
  broker: Omit<BrokerDeps, "credentials" | "secrets">;
  /** The reviewer's provider first, then the others (`providerChain`). */
  providers: readonly SandboxProvider[];
  image: string;
  network: string;
  /** The runner process starting the sandboxes: their `lgtmoose.runner` label (NIC-1056). */
  runnerId: string;
  /** The egress proxy, as sandboxes reach it on their network. */
  proxyUrl: string;
  timeoutMs: number;
  memoryBytes: number;
  cpus: number;
  /** How long a batch waits for a credential slot before it gives up on that provider. */
  leaseWaitMs: number;
  sleep(ms: number): Promise<void>;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** The local URL for an artifact key, and the file name the sandbox finds it under. */
function localName(key: string): string {
  return encodeURIComponent(key);
}

async function holdLease(
  deps: DockerBatchDeps,
  broker: BrokerDeps,
  provider: SandboxProvider,
  batch: { runId: string; index: number; executionArn: string },
): Promise<HeldLease | "stopped" | "busy"> {
  const started = Date.now();
  let wait = 20_000;
  for (;;) {
    try {
      return await acquireLease(broker, { action: "acquire", providerId: provider.id, ...batch });
    } catch (error) {
      if (!(error instanceof CredentialBusyError)) throw error;
    }
    if (!(await broker.executionRunning(batch.executionArn))) return "stopped";
    if (Date.now() - started >= deps.leaseWaitMs) return "busy";
    await deps.sleep(wait);
    wait = Math.min(wait * 2, 120_000);
  }
}

/** Runs one attempt's container and copies back what it wrote. Returns the batch output. */
async function runContainer(
  deps: DockerBatchDeps,
  provider: SandboxProvider,
  batch: { runId: string; index: number },
): Promise<string | undefined> {
  const keys = runKeys(batch.runId);
  const refresh = provider.auth === "chatgpt-login" && provider.credential !== undefined;
  // The URL set, as on AWS, with local URLs: each names one object of this batch only.
  const presigned = await presignBatch(
    {
      presign: async (_method, key) => `${LOCAL_BATCH_ORIGIN}/${localName(key)}`,
      putText: (key, body) => deps.store.putText(key, body),
    },
    { runId: batch.runId, index: batch.index, ...(refresh ? { credentialRefresh: true } : {}) },
    0,
  );
  const urlsKey = keys.batchUrls(batch.index);
  const urls = JSON.parse((await deps.store.getText(urlsKey)) ?? "{}") as {
    transcripts?: Record<string, string>;
  };
  const inbound: [string, Buffer][] = [];
  for (const key of [urlsKey, keys.batchInput(batch.index), keys.checkout]) {
    const object = await deps.store.getObject(key);
    if (object === undefined) throw new Error(`The batch's ${key} isn't in the artifact store.`);
    inbound.push([key, object.body]);
  }
  const owned = { mode: 0o600, uid: SANDBOX_UID, gid: SANDBOX_UID };
  const archive = writeTar([
    { name: "io", mode: 0o700, uid: SANDBOX_UID, gid: SANDBOX_UID },
    ...inbound.map(([key, body]) => ({ name: `io/${localName(key)}`, body, ...owned })),
  ]);

  const credential =
    provider.credential === undefined
      ? undefined
      : await deps.secrets.read(provider.credential.secretId);
  const id = await deps.docker.createSandbox({
    image: deps.image,
    network: deps.network,
    name: `lgtmoose-sandbox-${batch.runId.slice(0, 24)}-${batch.index}-${randomBytes(3).toString("hex")}`,
    labels: {
      [SANDBOX_LABEL]: "1",
      [RUNNER_LABEL]: deps.runnerId,
      "lgtmoose.run": batch.runId,
    },
    batchPath: BATCH_MOUNT,
    memoryBytes: deps.memoryBytes,
    cpus: deps.cpus,
    env: {
      LGTMOOSE_PROVIDER: provider.id,
      LGTMOOSE_HARNESS: provider.harness,
      LGTMOOSE_AUTH: provider.auth,
      LGTMOOSE_MODEL: provider.model,
      LGTMOOSE_FAST_MODEL: provider.fastModel,
      ...(provider.thinkingTokens === undefined
        ? {}
        : { LGTMOOSE_THINKING_TOKENS: String(provider.thinkingTokens) }),
      ...(provider.fastThinkingTokens === undefined
        ? {}
        : { LGTMOOSE_FAST_THINKING_TOKENS: String(provider.fastThinkingTokens) }),
      LGTMOOSE_BATCH_URLS: presigned.urls,
      LGTMOOSE_BATCH_DIR: BATCH_DIR,
      HTTPS_PROXY: deps.proxyUrl,
      HOME: "/tmp",
      ...(credential === undefined ? {} : { LGTMOOSE_PROVIDER_CREDENTIAL: credential }),
    },
  });
  try {
    await deps.docker.putArchive(id, BATCH_MOUNT, archive);
    await deps.docker.start(id);
    const code = await deps.docker.wait(id, deps.timeoutMs);
    if (code !== 0) {
      deps.log("sandbox exited with an error", {
        runId: batch.runId,
        index: batch.index,
        providerId: provider.id,
        code,
        // The sandbox never prints a credential (apps/sandbox/src/index.ts).
        output: (await deps.docker.logs(id, 20)).slice(-2000),
      });
    }
    // What the sandbox was allowed to write, and nothing else: the output, its transcripts and,
    // for a ChatGPT sign-in, the refreshed auth.json.
    const writable = [
      keys.batchOutput(batch.index),
      ...Object.keys(urls.transcripts ?? {}).map((key) => keys.batchTranscript(batch.index, key)),
      ...(refresh ? [keys.batchCredential(batch.index)] : []),
    ];
    const returned = await deps.docker.getArchive(id, BATCH_DIR);
    const files = returned === undefined ? new Map() : readTar(returned, MAX_OUTPUT_BYTES);
    for (const key of writable) {
      const body = files.get(`io/${localName(key)}`) as Buffer | undefined;
      if (body !== undefined) await deps.store.putText(key, body.toString("utf8"));
    }
    return deps.store.getText(keys.batchOutput(batch.index));
  } finally {
    await deps.docker.remove(id).catch((error: unknown) => {
      deps.log("sandbox not removed", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/** A `BatchRunner` that runs batches in sandbox containers, with leases and fallback. */
export function dockerBatchRunner(deps: DockerBatchDeps): BatchRunner {
  const broker: BrokerDeps = {
    ...deps.broker,
    secrets: deps.secrets,
    credentials: Object.fromEntries(
      deps.providers.flatMap((provider) =>
        provider.credential === undefined
          ? []
          : [
              [
                provider.id,
                {
                  secretId: provider.credential.secretId,
                  auth: provider.auth,
                  limit: provider.credential.limit,
                },
              ],
            ],
      ),
    ),
  };
  return async (batch) => {
    for (const [position, provider] of deps.providers.entries()) {
      const last = position === deps.providers.length - 1;
      const fields = { runId: batch.runId, index: batch.index, providerId: provider.id };
      let lease: HeldLease | undefined;
      if (provider.credential !== undefined) {
        const held = await holdLease(deps, broker, provider, batch);
        if (held === "stopped") return;
        if (held === "busy") {
          deps.log("no credential slot came free; trying the next provider", fields);
          if (last) throw new Error(`No credential slot for ${provider.id}.`);
          continue;
        }
        lease = held;
      }
      let output: string | undefined;
      let failed: unknown;
      try {
        output = await runContainer(deps, provider, batch);
      } catch (error) {
        failed = error;
      } finally {
        if (lease !== undefined) {
          await releaseLease(
            broker,
            {
              action: "release",
              providerId: provider.id,
              runId: batch.runId,
              index: batch.index,
              lease,
            },
            output,
          ).catch((error: unknown) => {
            deps.log("credential lease not given back", {
              ...fields,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
      if (failed !== undefined) {
        deps.log("sandbox attempt failed", {
          ...fields,
          error: failed instanceof Error ? failed.message : "unknown error",
        });
        if (last) throw failed;
        continue;
      }
      const { fallback, reason } = wantsFallback(output);
      deps.log(fallback ? "batch falls back to the next provider" : "batch done on this provider", {
        ...fields,
        reason,
      });
      if (!fallback || last) return;
    }
  };
}
