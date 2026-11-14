import { join } from "node:path";
import { findingSchema } from "@lgtmoose/core";
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
import { z } from "zod";
import { readOutcome } from "./outcomes.js";
import type { ControlDeps } from "./ports.js";

/** How the batches are run, from the control task's environment. */
export interface PrepareSettings {
  /** The reviewer's model; empty for the harness's default. */
  model: string;
  batchTimeoutMs: number;
}

export const MANIFEST_VERSION = 2;

/** What `runs/<id>/prepared.json` holds: the prepared review and the installation it's for. */
export interface RunManifest {
  version: typeof MANIFEST_VERSION;
  installationId: number;
  review: PreparedReview;
}

/** A manifest written before incremental reviews: the review lacks the fields they added. */
interface LegacyManifest {
  version: 1;
  installationId: number;
  review: Omit<PreparedReview, "kind" | "done" | "carried" | "unchanged" | "noLongerChanged">;
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

const depth = z.enum(["full", "mechanical", "move"]);
const reviewedFile = z.object({ path: z.string(), blobSha: z.string(), depth });

/**
 * The parts of a version 2 manifest that incremental reviews added or changed shape, checked
 * so a manifest of another shape (one from an earlier build of this version) is refused rather
 * than misread. The rest is passed through as written.
 */
const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  installationId: z.number().int().positive(),
  review: z.looseObject({
    kind: z.enum(["full", "incremental"]),
    done: z.array(z.object({ path: z.string(), depth })),
    carried: z.array(z.object({ files: z.array(z.string()), findings: z.array(findingSchema) })),
    unchanged: z.array(reviewedFile),
    noLongerChanged: z.array(z.object({ path: z.string(), lines: z.array(z.string()) })),
    jobs: z.array(
      z.looseObject({
        index: z.number().int().min(0),
        files: z.array(z.string()),
        prompt: z.string().optional(),
      }),
    ),
    files: z.array(z.looseObject({ path: z.string() })),
    plan: z.looseObject({ files: z.array(z.unknown()), skipped: z.array(z.unknown()) }),
  }),
});

/**
 * Parses a run's manifest. Written by the run's own prepare step with the control task's role:
 * trusted, not model output, but its shape is checked (see `manifestSchema`). A version 1
 * manifest from before incremental reviews (it has none of their fields) gets them, so a run
 * prepared before a deploy still posts after it. Anything else is refused rather than guessed
 * at.
 */
export function readManifest(text: string): RunManifest {
  const manifest = JSON.parse(text) as { version?: unknown; review?: Record<string, unknown> };
  if (manifest.version === MANIFEST_VERSION) {
    const parsed = manifestSchema.safeParse(manifest);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`Unsupported run manifest (version 2, unexpected fields: ${fields}).`);
    }
    return manifest as unknown as RunManifest;
  }
  const incrementalFields = ["kind", "done", "carried", "unchanged", "noLongerChanged"].filter(
    (field) => manifest.review !== undefined && field in manifest.review,
  );
  if (manifest.version !== 1 || manifest.review === undefined || incrementalFields.length > 0) {
    throw new Error(`Unsupported run manifest (version ${JSON.stringify(manifest.version)}).`);
  }
  const legacy = manifest as unknown as LegacyManifest;
  return {
    ...legacy,
    version: MANIFEST_VERSION,
    review: {
      ...legacy.review,
      kind: "full",
      done: [],
      carried: [],
      unchanged: [],
      noLongerChanged: [],
    },
  };
}

/**
 * The finished batches of the PR's recent runs that never posted (stopped by a newer push,
 * superseded or failed): the files each batch's prompt covered, at the blobs and depth it saw
 * them, and its findings. This run skips the files whose blobs haven't changed and posts their
 * findings. Nothing about them is recorded: only a posted run's files count as reviewed (see
 * `RunStore.reviewedFiles`), and the outputs stay in the artifact bucket for the next run.
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
  const earlierIds = await deps.runs.unpostedRuns(pullRequestId, runId, RESUME_RUNS);
  const perRun = await Promise.all(earlierIds.map((id) => resumableBatches(deps, id)));
  return perRun.flat();
}

async function resumableBatches(deps: ControlDeps, earlierId: string): Promise<ResumedWork[]> {
  const text = await deps.store.getText(runKeys(earlierId).prepared);
  // A run stopped before its prepare step finished has nothing to pick up.
  if (text === undefined) return [];
  let review: PreparedReview;
  try {
    ({ review } = readManifest(text));
  } catch (error) {
    // One unreadable earlier manifest mustn't stop every later run: its work is reviewed again.
    deps.log("skipped an unreadable earlier manifest", {
      runId: earlierId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const byPath = new Map(review.files.map((file) => [file.path, file]));
  const depthOf = new Map(review.plan.files.map((planned) => [planned.file.path, planned.depth]));
  const alreadyDone = new Set(review.done.map((entry) => entry.path));
  const jobs = review.jobs.filter((job) => job.prompt !== undefined);
  const outcomes = await Promise.all(
    jobs.map((job) => readOutcome(deps.store, earlierId, job.index)),
  );
  return jobs.flatMap((job, i) => {
    const findings = outcomes[i]?.findings;
    if (findings === undefined) return [];
    const covered = job.files.filter((path) => !alreadyDone.has(path));
    const paths = new Set(covered);
    const files = covered.flatMap((path) => {
      const file = byPath.get(path);
      const depth = depthOf.get(path);
      return file === undefined || depth === undefined
        ? []
        : [{ path, oldBlob: file.oldBlob, newBlob: file.newBlob, depth }];
    });
    return [{ files, findings: findings.filter((finding) => paths.has(finding.path)) }];
  });
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
  const lastReviewed = run.lastReviewedSha;
  const [resumed, reviewed] = await Promise.all([
    resumableWork(deps, run.pullRequestId, run.runId),
    deps.runs.reviewedFiles(run.pullRequestId),
  ]);
  const work = await deps.workDir();
  try {
    const checkout = join(work.dir, "checkout");
    const repo = await deps.clone({
      url: deps.cloneUrl(target.owner, target.repo),
      dir: checkout,
      headSha: pr.headSha,
      // The commits files were last reviewed at, to compare their PR changes with.
      otherShas: [pr.baseSha, ...new Set(reviewed.map((file) => file.reviewedAt))],
      token: await github.token(),
    });
    const prepared = await prepareReview(
      { github: github.reader, progress: (line) => deps.log(line) },
      target,
      repo,
      pr,
      { reviewed, resumed },
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
        ...(prepared.reviewerSystem === undefined ? {} : { system: prepared.reviewerSystem }),
        model: settings.model,
        timeoutMs: settings.batchTimeoutMs,
      });
      await deps.store.putText(keys.batchInput(batch.index), JSON.stringify(input));
      batches.push({ index: batch.index });
    }
    const manifest: RunManifest = {
      version: MANIFEST_VERSION,
      installationId: job.installationId,
      review: prepared,
    };
    await deps.store.putText(keys.prepared, JSON.stringify(manifest));
    await deps.runs.setPlan(run.runId, {
      filesTotal: prepared.plan.files.length,
      kind: runKind(prepared, lastReviewed),
      fromSha: prepared.kind === "incremental" ? lastReviewed : undefined,
    });
    deps.log("prepared", {
      runId: run.runId,
      kind: prepared.kind,
      batches: batches.length,
      done: prepared.done.length,
      carriedBatches: prepared.carried.length,
      carriedFindings: prepared.carried.flatMap((batch) => batch.findings).length,
      ...(prepared.fallbackReason === undefined ? {} : { fallback: prepared.fallbackReason }),
    });
    return { runId: run.runId, superseded: false, batches };
  } finally {
    await work.remove();
  }
}
