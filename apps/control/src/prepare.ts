import { join } from "node:path";
import type { Repo } from "@lgtmoose/git";
import {
  batchInputSchema,
  prepareReview,
  runKeys,
  type BatchInput,
  type PreparedReview,
} from "@lgtmoose/pipeline";
import { jobTarget, type WorkflowJob } from "./job.js";
import type { ControlDeps } from "./ports.js";

/** How the batches are run, from the control task's environment. */
export interface PrepareSettings {
  /** The reviewer's model; empty for the harness's default. */
  model: string;
  batchTimeoutMs: number;
}

/** What `runs/<id>/prepared.json` holds: the prepared review and the installation it's for. */
export interface RunManifest {
  version: 1;
  installationId: number;
  review: PreparedReview;
}

/** What the prepare step hands the state machine: the run and the batches to map over. */
export interface PrepareOutput {
  runId: string;
  /** True when the PR's head moved on before the run started; nothing else runs then. */
  superseded: boolean;
  /** The batches with a prompt, for the map state. Moved-only batches aren't listed. */
  batches: { index: number }[];
}

/**
 * Gives the sandbox's checkout every object `git diff` and `git show` need for the PR's files,
 * then stops it fetching more: sandboxes can't reach GitHub, so a lazy fetch would only hang
 * on the egress proxy. Commands that need other history fail at once instead.
 */
async function sealCheckout(repo: Repo, prepared: PreparedReview): Promise<void> {
  const blobs = prepared.files.flatMap((file) =>
    file.submodule ? [] : [file.oldBlob, file.newBlob].filter((b): b is string => b !== undefined),
  );
  await repo.readBlobs(blobs);
  for (const key of ["remote.origin.promisor", "remote.origin.partialclonefilter"]) {
    await repo.git(["config", "--unset-all", key], { okExitCodes: [5] });
  }
}

/**
 * The prepare step: records the run, clones the PR, plans it and writes each batch's input, the
 * checkout archive and the prepared review to the artifact bucket. It runs once per execution.
 */
export async function prepare(
  deps: ControlDeps,
  job: WorkflowJob,
  executionArn: string,
  settings: PrepareSettings,
): Promise<PrepareOutput> {
  const target = jobTarget(job);
  const github = await deps.github(job.installationId);
  const pr = await github.reader.pull(target);
  const run = await deps.runs.startRun({
    installationId: job.installationId,
    repo: job.repo,
    number: job.prNumber,
    author: pr.author,
    headSha: job.headSha ?? pr.headSha,
    baseSha: pr.baseSha,
    executionArn,
    ...(job.eventAt === undefined ? {} : { eventAt: new Date(job.eventAt) }),
  });
  if (job.headSha !== undefined && job.headSha !== pr.headSha) {
    // A newer push has its own execution; this one reviews nothing.
    await deps.runs.supersedeRun(run.runId);
    deps.log("superseded", { runId: run.runId, queued: job.headSha, head: pr.headSha });
    return { runId: run.runId, superseded: true, batches: [] };
  }

  const keys = runKeys(run.runId);
  const work = await deps.workDir();
  try {
    const checkout = join(work.dir, "checkout");
    const repo = await deps.clone({
      url: deps.cloneUrl(target.owner, target.repo),
      dir: checkout,
      headSha: pr.headSha,
      otherShas: [pr.baseSha],
      token: await github.token(),
    });
    const prepared = await prepareReview(
      { github: github.reader, progress: (line) => deps.log(line) },
      target,
      repo,
      pr,
    );
    await sealCheckout(repo, prepared);
    const archive = join(work.dir, "checkout.tar.gz");
    await deps.archive(checkout, archive);
    await deps.store.putFile(keys.checkout, archive, "application/gzip");

    const batches: { index: number }[] = [];
    for (const batch of prepared.jobs) {
      if (batch.prompt === undefined) continue;
      const input: BatchInput = batchInputSchema.parse({
        version: 1,
        runId: run.runId,
        index: batch.index,
        prompt: batch.prompt,
        model: settings.model,
        timeoutMs: settings.batchTimeoutMs,
      });
      await deps.store.putText(keys.batchInput(batch.index), JSON.stringify(input));
      batches.push({ index: batch.index });
    }
    const manifest: RunManifest = {
      version: 1,
      installationId: job.installationId,
      review: prepared,
    };
    await deps.store.putText(keys.prepared, JSON.stringify(manifest));
    await deps.runs.setFilesTotal(run.runId, prepared.plan.files.length);
    deps.log("prepared", { runId: run.runId, batches: batches.length });
    return { runId: run.runId, superseded: false, batches };
  } finally {
    await work.remove();
  }
}
