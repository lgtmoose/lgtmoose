import { z } from "zod";

/**
 * What the explainer returns when a person asks `@lgtmoose explain` on one of our findings: a
 * short answer and, optionally, the line at head that shows it. It's model output on untrusted
 * text (the finding and the code), so it can only say a few words: it has no field that does
 * anything. Plain code scans it for prompt injection and escapes it before it's posted.
 *
 * Field names are snake_case like the finding's, and each has a description the model sees.
 */

/** The longest answer the explainer may write, for a reply on GitHub. */
export const MAX_EXPLANATION_TEXT = 1200;

export const explanationSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(MAX_EXPLANATION_TEXT)
      .describe(
        "Why the finding matters and what would address it, from the code you read. A few plain sentences. No thanks, greetings, @-mentions, links or promises.",
      ),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The line at head, in the finding's file, that best shows your answer."),
  })
  .strict();

export type Explanation = z.infer<typeof explanationSchema>;
