import { join } from "node:path";
import type { Harness, TranscriptStore } from "@lgtmoose/harness";
import {
  batchInputSchema,
  batchOutputSchema,
  batchRunId,
  batchUrlsSchema,
  runBatch,
  type BatchOutput,
  type BatchUrls,
} from "@lgtmoose/pipeline";

export interface SandboxDeps {
  fetch: typeof fetch;
  /** Streams `body` to a local file: a checkout can be larger than the task's memory. */
  writeFile(path: string, body: ReadableStream<Uint8Array>): Promise<void>;
  /** Extracts a gzip tarball into `dir`, which it creates. */
  extract(archive: string, dir: string): Promise<void>;
  /**
   * Removes every symlink in the checkout (see `dropSymlinks`), returning
   * their paths. Runs before the harness sees the checkout.
   */
  dropSymlinks(dir: string): Promise<string[]>;
  /**
   * The harness for this task's provider, saving transcripts to `transcripts`. A harness whose
   * CLI refreshes its credential (Codex with a ChatGPT sign-in) hands the new one to
   * `onAuthRefreshed`.
   */
  harness(
    transcripts: TranscriptStore,
    onAuthRefreshed: (credential: string) => Promise<void>,
  ): Harness;
  /** A writable directory for the checkout. */
  workDir: string;
  /**
   * The model this task's provider runs (`LGTMOOSE_MODEL`; empty for the harness's default).
   * Undefined: the input's, the reviewer provider's.
   */
  model?: string;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** The URL's path only: the query string is the signature. */
function where(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "(not a URL)";
  }
}

async function get(deps: SandboxDeps, url: string): Promise<Response> {
  const response = await deps.fetch(url);
  if (!response.ok) throw new Error(`GET ${where(url)} failed with HTTP ${response.status}.`);
  return response;
}

async function put(deps: SandboxDeps, url: string, body: string): Promise<void> {
  const response = await deps.fetch(url, {
    method: "PUT",
    body,
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw new Error(`PUT ${where(url)} failed with HTTP ${response.status}.`);
}

/** Transcripts go to their presigned PUTs. A key without one is logged and dropped. */
function presignedTranscripts(deps: SandboxDeps, urls: BatchUrls): TranscriptStore {
  return {
    async put(key, body) {
      const url = urls.transcripts[key];
      if (url === undefined) {
        deps.log("transcript has no URL", { key });
        return;
      }
      await put(deps, url, body);
    },
  };
}

/**
 * One sandbox task: reads its batch through the presigned URLs, extracts the checkout, runs the
 * reviewer on the batch and writes the outcome. A model failure (timeout, rate limit, invalid
 * output) is written as the batch's error and the task succeeds; the post step counts it as a
 * failed batch. Anything before the run (an expired URL, a bad input) throws, so the task fails
 * and the state machine retries it.
 */
export async function runSandboxBatch(deps: SandboxDeps, batchUrls: string): Promise<BatchOutput> {
  const urls = batchUrlsSchema.parse(await (await get(deps, batchUrls)).json());
  const input = batchInputSchema.parse(await (await get(deps, urls.input)).json());

  const archive = join(deps.workDir, "checkout.tar.gz");
  const checkout = join(deps.workDir, "checkout");
  const download = await get(deps, urls.checkout);
  if (download.body === null) throw new Error("The checkout download has no body.");
  await deps.writeFile(archive, download.body);
  await deps.extract(archive, checkout);
  // Read rules match the path the model asks for, not where a link leads.
  const dropped = await deps.dropSymlinks(checkout);
  if (dropped.length > 0) {
    deps.log("removed symlinks from the checkout", {
      count: dropped.length,
      paths: dropped.slice(0, 20),
    });
  }

  // A refreshed credential goes to its own presigned PUT, for the credential broker to store.
  // Without one, it's dropped: the provider's secret keeps the credential the task started with.
  const onAuthRefreshed = async (credential: string) => {
    if (urls.credential === undefined) {
      deps.log("the credential was refreshed, but there's nowhere to hand it back");
      return;
    }
    await put(deps, urls.credential, credential);
    deps.log("handed the refreshed credential back");
  };
  const outcome = await runBatch(
    deps.harness(presignedTranscripts(deps, urls), onAuthRefreshed),
    { index: input.index, files: [], prompt: input.prompt },
    {
      cwd: checkout,
      // This task's provider's model: a batch that fell back to it runs its model, not the
      // reviewer provider's in the input.
      model: deps.model ?? input.model,
      timeoutMs: input.timeoutMs,
      runId: batchRunId(input.runId, input.index),
      ...(input.system === undefined ? {} : { system: input.system }),
    },
  );
  const output: BatchOutput = batchOutputSchema.parse({
    version: 1,
    index: input.index,
    ...(outcome.findings === undefined ? {} : { findings: outcome.findings }),
    ...(outcome.notes === undefined ? {} : { notes: outcome.notes }),
    ...(outcome.error === undefined ? {} : { error: outcome.error.slice(0, 4000) }),
    transcriptKeys: outcome.transcriptKeys.slice(0, 3),
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  });
  await put(deps, urls.output, JSON.stringify(output));
  deps.log("batch done", {
    index: input.index,
    findings: output.findings?.length ?? 0,
    error: output.error,
  });
  return output;
}
