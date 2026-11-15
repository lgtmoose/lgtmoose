import { z } from "zod";
import { BOOTSTRAP_DEFAULTS, type BootstrapJob } from "./bootstrap.js";
import type { BootstrapStore } from "./bootstrap-store.js";

/**
 * The reconciler's part in learning from review history (NIC-1080): it takes in the requests the
 * CLI left in the artifact bucket, fails bootstraps whose execution was lost, and starts a
 * workflow execution for each requested one on a repository the App is installed on (and whose
 * owner is allowed). The reconciler already knows which installation holds each repository, so
 * nobody has to name one.
 */

/** A bootstrap running for longer than this lost its execution. */
export const STALE_BOOTSTRAP_MS = 6 * 3600 * 1000;
/** Bootstraps started per reconcile. */
const STARTS_PER_RUN = 5;

/** What `lgtmoose learnings bootstrap` writes (`BOOTSTRAP_REQUEST_PREFIX`). */
export const bootstrapRequestFileSchema = z
  .object({
    version: z.literal(1),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    maxPrs: z.number().int().min(1).max(BOOTSTRAP_DEFAULTS.maxPrsLimit).optional(),
    maxCostUsd: z.number().min(0).max(1000).optional(),
    resume: z.boolean().optional(),
  })
  .strict();

export type BootstrapRequestFile = z.infer<typeof bootstrapRequestFileSchema>;

export interface BootstrapStarter {
  store: Pick<BootstrapStore, "request" | "requested" | "start" | "fail" | "failStale">;
  /** Starts the review workflow with a bootstrap job; the execution's ARN. */
  startExecution(name: string, input: BootstrapJob & { debounceSeconds: 0 }): Promise<string>;
  /** The CLI's requests, taken out of the artifact bucket (AWS only). */
  incoming?(): Promise<BootstrapRequestFile[]>;
  /** The deployment's cost cap per bootstrap (`learnings.bootstrapMaxCostUsd`). */
  maxCostUsd: number;
}

/**
 * Takes in the CLI's requests and starts the requested bootstraps. `installations` maps each
 * repository the reconciler checked (lower case) to its installation; `complete` is false when
 * some installation couldn't be read, so a repository missing from it may still be there and its
 * bootstrap waits for the next run instead of failing. Returns how many were started.
 */
export async function startBootstraps(
  deps: BootstrapStarter,
  installations: ReadonlyMap<string, number>,
  complete: boolean,
  now: Date,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<number> {
  for (const request of (await deps.incoming?.()) ?? []) {
    const result = await deps.store.request({
      repo: request.repo,
      requestedBy: "operator",
      maxPrs: request.maxPrs ?? BOOTSTRAP_DEFAULTS.maxPrs,
      maxCostUsd: Math.min(request.maxCostUsd ?? deps.maxCostUsd, deps.maxCostUsd),
      ...(request.resume === undefined ? {} : { resume: request.resume }),
    });
    log("bootstrap requested", {
      repo: request.repo,
      created: result.created,
      ...(result.created ? {} : { active: result.active.id }),
    });
  }
  const lost = await deps.store.failStale(new Date(now.getTime() - STALE_BOOTSTRAP_MS));
  if (lost > 0) log("bootstraps lost", { count: lost });
  let started = 0;
  for (const bootstrap of await deps.store.requested(STARTS_PER_RUN)) {
    const installationId = installations.get(bootstrap.repo);
    if (installationId === undefined) {
      if (complete) {
        await deps.store.fail(
          bootstrap.id,
          `LGTMoose isn't installed on ${bootstrap.repo}, or its owner isn't in allowedOrgs.`,
        );
      }
      continue;
    }
    const executionArn = await deps.startExecution(`bootstrap-${bootstrap.id}`, {
      bootstrapId: bootstrap.id,
      installationId,
      repo: bootstrap.repo,
      debounceSeconds: 0,
    });
    if (await deps.store.start(bootstrap.id, executionArn)) started += 1;
    log("bootstrap started", { bootstrapId: bootstrap.id, repo: bootstrap.repo, executionArn });
  }
  return started;
}
