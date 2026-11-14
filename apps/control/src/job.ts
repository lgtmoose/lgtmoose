import { z } from "zod";

/**
 * The part of a review job (`ReviewJob` from @lgtmoose/core, as the dispatcher passes it to the
 * state machine) that the control task reads. Validated again here: the execution input comes
 * from the queue.
 */
export const workflowJobSchema = z.object({
  installationId: z.number().int().positive(),
  /** "owner/name". */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "use owner/name"),
  prNumber: z.number().int().positive(),
  /** The head the job was queued for. A run for an older head is superseded. */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
    .optional(),
});

export type WorkflowJob = z.infer<typeof workflowJobSchema>;

export function parseJob(text: string | undefined): WorkflowJob {
  if (text === undefined || text.trim() === "") throw new Error("LGTMOOSE_JOB is not set.");
  return workflowJobSchema.parse(JSON.parse(text));
}

export function jobTarget(job: WorkflowJob): { owner: string; repo: string; number: number } {
  const [owner = "", repo = ""] = job.repo.split("/");
  return { owner, repo, number: job.prNumber };
}
