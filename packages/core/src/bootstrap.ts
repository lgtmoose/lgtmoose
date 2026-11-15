import { z } from "zod";

/**
 * What the bootstrapper returns (NIC-1080): candidate learnings distilled from a repository's past
 * code review comments. It's model output on untrusted text (the comments), so it can only
 * propose: a kind, a short text, a category, an optional path glob and the comments it rests on.
 * No field says who wrote it, applies it or approves it. Plain code checks every candidate (at
 * least two distinct cited comments that exist in the batch, the learnings write policy, the
 * prompt-injection detector) and stores what's left as pending, for a person to approve.
 *
 * Field names are snake_case like the finding's, and each has a description the model sees.
 */

/** The kinds a bootstrap may propose: corrections come from a finding being wrong, not history. */
export const BOOTSTRAP_KINDS = ["convention", "accepted_pattern", "scoping"] as const;

export const BOOTSTRAP_LIMITS = {
  /** Candidates one batch may return. */
  candidates: 15,
  /** The longest candidate text. */
  text: 400,
  /** The most comments one candidate cites. */
  sources: 10,
  pathGlob: 200,
} as const;

/** A comment's ID in the bootstrapper's prompt: `c1`, `c2`… */
export const BOOTSTRAP_COMMENT_ID = /^c[1-9][0-9]{0,3}$/;

export const bootstrapCandidateSchema = z
  .object({
    kind: z
      .enum(BOOTSTRAP_KINDS)
      .describe(
        "convention: how this team writes code. accepted_pattern: something reviewers here accept, which a reviewer shouldn't flag. scoping: where or when a kind of finding doesn't apply.",
      ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(BOOTSTRAP_LIMITS.text)
      .describe(
        "The rule, in one or two plain sentences a reviewer can follow. No names, @-mentions, links or quotes of the comments.",
      ),
    category: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional()
      .describe("The finding category it's about, such as style, tests or error_handling."),
    path_glob: z
      .string()
      .min(1)
      .max(BOOTSTRAP_LIMITS.pathGlob)
      .optional()
      .describe("Only when the rule holds for some paths: a glob relative to the repository root."),
    sources: z
      .array(z.string().regex(BOOTSTRAP_COMMENT_ID))
      .min(2)
      .max(BOOTSTRAP_LIMITS.sources)
      .describe(
        "The IDs of the comments the rule rests on, such as c3 and c17. At least two different comments: one remark is never a rule.",
      ),
  })
  .strict();

export type BootstrapCandidate = z.infer<typeof bootstrapCandidateSchema>;

export const bootstrapOutputSchema = z
  .object({
    candidates: z
      .array(bootstrapCandidateSchema)
      .max(BOOTSTRAP_LIMITS.candidates)
      .describe("The rules the comments show. An empty list when they show none."),
  })
  .strict();

export type BootstrapOutput = z.infer<typeof bootstrapOutputSchema>;
