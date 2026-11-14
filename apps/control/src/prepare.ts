import { join } from "node:path";
import type { Repo } from "@lgtmoose/git";
import {
  batchInputSchema,
  prepareReview,
  runKeys,
  type BatchInput,
  type PreparedReview,
  type ResumedWork,
} from "@lgtmoose/pipeline";
import { jobTarget, type WorkflowJob } from "./job.js";
import { readOutcome } from "./outcomes.js";
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

/** How many of a PR's unposted runs are looked at for finished batches. */
export const RESUME_RUNS = 3;

function runKind(
  prepared: PreparedReview,
  lastReviewed: string | undefined,
): "first" | "incremental" | "full" {
  if (lastReviewed === undefined) return "first";
  return prepared.kind;
}

/**
 * The finished batches of the PR's recent runs that never posted (stopped by a newer push,
 * superseded or failed): the files each batch's prompt covered, at the blobs it saw, and its
 * findings. This run skips the files whose blobs haven't changed and posts their findings.
 * They're also recorded under their own run, for the record; only a posted run's files count
 * as reviewed later (see `RunStore.reviewedFiles`).
 *
 * Files a batch had as done already are left out: their findings, if any, came from an older
 * run, and are picked up from that run while it's among the recent ones. Past that, the file
 * is reviewed again rather than its findings lost.
 */
async function resumableWork(
  deps: ControlDeps,
  pullRequestId: string,
  runId: string,
): Promise<ResumedWork[]> {
  const work: ResumedWork[] = [];
  for (const earlierId of await deps.runs.unpostedRuns(pullRequestId, runId, RESUME_RUNS)) {
    const text = await deps.store.getText(runKeys(earlierId).prepared);
    // A run stopped before its prepare step finished has nothing to pick up.
    if (text === undefined) continue;
    // Written by that run's prepare step with the control task's role, like our own.
    const review = (JSON.parse(text) as RunManifest).review;
    const byPath = new Map(review.files.map((file) => [file.path, file]));
    const depthOf = new Map(review.plan.files.map((planned) => [planned.file.path, planned.depth]));
    const alreadyDone = new Set(review.done);
    const jobs = review.jobs.filter((job) => job.prompt !== undefined);
    const outcomes = await Promise.all(
      jobs.map((job) => readOutcome(deps.store, earlierId, job.index)),
    );
    for (const [i, job] of jobs.entries()) {
      const outcome = outcomes[i];
      if (outcome?.findings === undefined) continue;
      const covered = job.files.filter((path) => !alreadyDone.has(path));
      const paths = new Set(covered);
      const files = covered.flatMap((path) => {
        const file = byPath.get(path);
        return file === undefined ? [] : [{ path, oldBlob: file.oldBlob, newBlob: file.newBlob }];
      });
      await deps.runs.recordFiles(
        earlierId,
        files.flatMap(({ path, newBlob }) =>
          newBlob === undefined
            ? []
            : [{ path, blobSha: newBlob, depth: depthOf.get(path) ?? "full" }],
        ),
      );
      work.push({ files, findings: outcome.findings.filter((finding) => paths.has(finding.path)) });
    }
  }
  return work;
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
  });
  if (job.headSha !== undefined && job.headSha !== pr.headSha) {
    // A newer push has its own execution; this one reviews nothing.
    await deps.runs.supersedeRun(run.runId);
    deps.log("superseded", { runId: run.runId, queued: job.headSha, head: pr.headSha });
    return { runId: run.runId, superseded: true, batches: [] };
  }

  const keys = runKeys(run.runId);
  const lastReviewed = run.lastReviewedSha;
  const resumed = await resumableWork(deps, run.pullRequestId, run.runId);
  const reviewed = await deps.runs.reviewedFiles(run.pullRequestId);
  const work = await deps.workDir();
  try {
    const checkout = join(work.dir, "checkout");
    const repo = await deps.clone({
      url: deps.cloneUrl(target.owner, target.repo),
      dir: checkout,
      headSha: pr.headSha,
      otherShas: lastReviewed === undefined ? [pr.baseSha] : [pr.baseSha, lastReviewed],
      token: await github.token(),
    });
    const prepared = await prepareReview(
      { github: github.reader, progress: (line) => deps.log(line) },
      target,
      repo,
      pr,
      {
        ...(lastReviewed === undefined ? {} : { lastReviewed }),
        reviewed,
        resumed,
      },
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
    await deps.runs.setPlan(run.runId, {
      filesTotal: prepared.plan.files.length,
      kind: runKind(prepared, lastReviewed),
      fromSha: prepared.lastReviewed,
    });
    deps.log("prepared", {
      runId: run.runId,
      kind: prepared.kind,
      batches: batches.length,
      done: prepared.done.length,
      carried: prepared.carried.length,
      ...(prepared.fallbackReason === undefined ? {} : { fallback: prepared.fallbackReason }),
    });
    return { runId: run.runId, superseded: false, batches };
  } finally {
    await work.remove();
  }
}
