import { z } from "zod";
import { SEVERITIES } from "./severity.js";

/**
 * The verifier's answer for one finding. This is JSON the model returns, so field names are
 * snake_case like the finding's, and each field has a description that ends up in the JSON
 * Schema the model sees.
 */
export const verdictSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(20)
      .describe("The id of the finding this verdict is for, exactly as the prompt gives it."),
    confirmed: z
      .boolean()
      .describe(
        "true only if you found concrete evidence that the problem is real. false if it isn't, or you can't show that it is.",
      ),
    reason: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "The evidence, in a few plain sentences: the guard, caller, test or code path that shows the problem is or isn't real.",
      ),
    adjusted_severity: z
      .enum(SEVERITIES)
      .optional()
      .describe(
        "Only when confirmed and the reviewer's severity is wrong: blocking, should_fix or nit, as the instructions define them.",
      ),
  })
  .strict();

export type Verdict = z.infer<typeof verdictSchema>;

/** The most findings one verifier run checks (nits are batched; everything else runs alone). */
export const MAX_FINDINGS_PER_VERIFIER_RUN = 10;

/** What a verifier run returns: one verdict per finding it was given. */
export const verifierOutputSchema = z.object({
  verdicts: z
    .array(verdictSchema)
    .max(MAX_FINDINGS_PER_VERIFIER_RUN)
    .describe("One verdict for each finding in the prompt, in any order."),
});

export type VerifierOutput = z.infer<typeof verifierOutputSchema>;
