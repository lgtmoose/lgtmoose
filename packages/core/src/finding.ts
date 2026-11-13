import { z } from "zod";
import { SEVERITIES, severityRank } from "./severity.js";

/** Which version of the file a line number refers to. Matches `Side` in @lgtmoose/git. */
export const SIDES = ["LEFT", "RIGHT"] as const;

export type FindingSide = (typeof SIDES)[number];

const lineNumber = z.number().int().positive();

/**
 * Limits on what one reviewer run may return, so a runaway or prompt-injected model can't flood
 * a pull request or exceed GitHub's comment limits. `findingsPerRun` is a soft limit: the model
 * is asked to stay under it and `keepMostSevere` trims the rest, so a batch with many real
 * findings isn't lost. Past `findingsHardMax`, and over the text limits, output fails
 * validation and gets the harness's repair retry.
 */
export const FINDING_LIMITS = {
  findingsPerRun: 50,
  findingsHardMax: 500,
  notesPerRun: 30,
  note: 500,
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

const findingsField = z
  .array(findingSchema)
  .max(FINDING_LIMITS.findingsHardMax)
  .describe(
    `Every finding, or an empty list. At most ${FINDING_LIMITS.findingsPerRun}: keep the most important.`,
  );

/**
 * What a reviewer run returns. `notes` are short facts for the cross-file pass (new exports,
 * env vars read, new required props, flows touched), which sees only these, not the batches.
 */
export const reviewerOutputSchema = z.object({
  findings: findingsField,
  notes: z
    .array(z.string().min(1).max(FINDING_LIMITS.note))
    .max(FINDING_LIMITS.notesPerRun)
    .optional()
    .describe(
      "Short facts for the cross-file pass, one per entry: exports, env vars, secrets and config keys, required props and flows this batch adds, changes or relies on. Leave out when there are none.",
    ),
});

/** What the cross-file pass returns: findings only. */
export const crossFileOutputSchema = z.object({ findings: findingsField });

export type CrossFileOutput = z.infer<typeof crossFileOutputSchema>;

export type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;

/**
 * The `limit` most severe findings, in their original order, and how many were dropped. Ties
 * keep the earlier finding.
 */
export function keepMostSevere(
  findings: readonly Finding[],
  limit: number = FINDING_LIMITS.findingsPerRun,
): { kept: Finding[]; dropped: number } {
  if (findings.length <= limit) return { kept: [...findings], dropped: 0 };
  const chosen = new Set(
    findings
      .map((finding, index) => ({ rank: severityRank(finding.severity), index }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, limit)
      .map(({ index }) => index),
  );
  return {
    kept: findings.filter((_, index) => chosen.has(index)),
    dropped: findings.length - limit,
  };
}
