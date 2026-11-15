import { z } from "zod";

/**
 * What the reply judge returns for one person's reply on one of our findings' review threads.
 * It's model output on untrusted text (the reply), so it only classifies and says a few words:
 * plain code decides what to do with it (see `decideReply` in @lgtmoose/control), and the
 * classification alone never clears a blocking finding.
 *
 * Field names are snake_case like the finding's, and each has a description the model sees.
 */
export const REPLY_KINDS = ["fixed", "declined", "disputed", "question", "other"] as const;

export type ReplyKind = (typeof REPLY_KINDS)[number];

/** The longest text the judge may write, for a reply on GitHub. */
export const MAX_JUDGEMENT_TEXT = 1200;

export const judgementSchema = z
  .object({
    kind: z
      .enum(REPLY_KINDS)
      .describe(
        "fixed: they say the code now fixes it. declined: they accept the finding is real but won't change it, or explain why it's intended. disputed: they say the finding is wrong. question: they ask about the finding. other: anything else, such as thanks.",
      ),
    fixed_at_head: z
      .boolean()
      .optional()
      .describe(
        "For fixed only: true only if you read the file at head and the cited problem is gone. false if it's still there or you can't tell.",
      ),
    still_valid: z
      .boolean()
      .optional()
      .describe(
        "For disputed only: true if, having read the code at head, the finding is still right. false only with concrete evidence that it's wrong.",
      ),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "The line at head, in the finding's file, that shows your answer: where the problem still is, or the evidence for it.",
      ),
    text: z
      .string()
      .max(MAX_JUDGEMENT_TEXT)
      .optional()
      .describe(
        "For a question, the answer; for a finding that isn't fixed or is still valid, the evidence. A few plain sentences. No thanks, no greetings, no @-mentions, no links.",
      ),
    learning: z
      .string()
      .max(500)
      .optional()
      .describe(
        "For declined only, when their reason is a general rule for this repository (not about this one change): that rule, in one sentence.",
      ),
  })
  .strict();

export type Judgement = z.infer<typeof judgementSchema>;
