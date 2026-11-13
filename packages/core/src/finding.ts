import { z } from "zod";
import { SEVERITIES } from "./severity.js";

/** Which version of the file a line number refers to. Matches `Side` in @lgtmoose/git. */
export const SIDES = ["LEFT", "RIGHT"] as const;

export type FindingSide = (typeof SIDES)[number];

const lineNumber = z.number().int().positive();

/**
 * Limits on what one reviewer run may return, so a runaway or prompt-injected model can't flood
 * a pull request or exceed GitHub's comment limits. Output over them fails validation, which
 * gets the harness's repair retry.
 */
export const FINDING_LIMITS = {
  findingsPerRun: 50,
  body: 4000,
  evidence: 2000,
  suggestion: 4000,
} as const;

/**
 * One problem a reviewer found. This is the JSON the model returns, so field names are
 * snake_case, and each field has a description that ends up in the JSON Schema the model sees.
 */
export const findingSchema = z
  .object({
    rule_category: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe(
        "The rule category this finding falls under, such as correctness or tests. Use a category id from the rule packs, or convention for a rule from the repo's convention files.",
      ),
    severity: z
      .enum(SEVERITIES)
      .describe("blocking, should_fix or nit, as the instructions define them."),
    path: z.string().min(1).describe("The file's path at head, exactly as the diff shows it."),
    line: lineNumber.describe(
      "The line the finding is about, numbered as in the diff. For a range, its last line.",
    ),
    side: z
      .enum(SIDES)
      .describe(
        "RIGHT for a line of the new version (R lines), LEFT for a deleted line (L lines).",
      ),
    start_line: lineNumber
      .optional()
      .describe("The first line of a range, on the same side. Leave it out for a single line."),
    title: z.string().min(1).max(200).describe("One short sentence that names the problem."),
    body: z
      .string()
      .min(1)
      .max(FINDING_LIMITS.body)
      .describe("What is wrong, why it matters and how to fix it, in plain, short sentences."),
    evidence: z
      .string()
      .min(1)
      .max(FINDING_LIMITS.evidence)
      .describe("The text of the diff line or lines the finding is about, copied exactly."),
    suggestion: z
      .string()
      .max(FINDING_LIMITS.suggestion)
      .optional()
      .describe(
        "Replacement code for the lines from start_line (or line) to line, when a small fix is clear. Code only, no fences.",
      ),
  })
  .refine((finding) => finding.start_line === undefined || finding.start_line <= finding.line, {
    message: "start_line must not come after line",
    path: ["start_line"],
  });

export type Finding = z.infer<typeof findingSchema>;

/** What a reviewer run returns. An empty list means there was nothing worth reporting. */
export const reviewerOutputSchema = z.object({
  findings: z
    .array(findingSchema)
    .max(FINDING_LIMITS.findingsPerRun)
    .describe(
      `Every finding, or an empty list. At most ${FINDING_LIMITS.findingsPerRun}: keep the most important.`,
    ),
});

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
