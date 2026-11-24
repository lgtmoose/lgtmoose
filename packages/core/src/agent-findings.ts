import { z } from "zod";
import type { AgentFinding } from "./agent-markdown.js";

/**
 * A pull request's open findings as the findings API returns them (NIC-1140), and answers to
 * them. The markdown for a coding agent is in `agent-markdown.ts`, which has no zod, so the
 * dashboard can bundle it for the browser.
 */

export { agentFindingsMarkdown, plainLine, type AgentFinding } from "./agent-markdown.js";

export const answerOutcomes = ["fixed", "declined"] as const;
export type AnswerOutcome = (typeof answerOutcomes)[number];

/** The longest reason a decline keeps. */
export const MAX_DECLINE_REASON = 2000;

/** The body of `POST /api/findings/:id/ack`. */
export const answerRequestSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("fixed") }),
  z.object({
    outcome: z.literal("declined"),
    reason: z
      .string()
      .trim()
      .min(1, "a decline needs a reason")
      .max(MAX_DECLINE_REASON)
      // Postgres can't store a NUL in text: refused here, not a server error later.
      .refine((reason) => !reason.includes("\u0000"), "a reason can't contain a NUL character"),
  }),
]);
export type AnswerRequest = z.infer<typeof answerRequestSchema>;

/** One open finding, as the findings API lists it. */
export const agentFindingSchema = z.object({
  /** The finding's ID: a UUID, so it can't carry anything else into the markdown. */
  id: z.uuid(),
  repo: z.string(),
  number: z.number().int(),
  severity: z.enum(["blocking", "should_fix", "nit"]),
  ruleCategory: z.string(),
  title: z.string(),
  body: z.string(),
  path: z.string().optional(),
  line: z.number().int().optional(),
  /** Whether it's still at its line (`open`) or its line has gone (`outdated`). */
  status: z.enum(["open", "outdated"]).optional(),
  /** When someone said it's fixed: it waits for the next run's recheck. */
  fixClaimedAt: z.string().optional(),
  fixClaimedBy: z.string().optional(),
  /** Who raised it: LGTMoose (`self`), or another reviewer, whose findings are on GitHub. */
  source: z.enum(["self", "bot", "human"]).optional(),
  /** Whether it can be marked fixed: on a line of the new code, which a recheck can check. */
  recheckable: z.boolean().optional(),
});

// The schema and the plain `AgentFinding` (which the browser bundle uses) must describe the same
// object: the same keys, and each assignable to the other. A field one adds, drops or retypes
// that the other misses fails the type check here.
type Parsed = z.infer<typeof agentFindingSchema>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameKeys: Same<keyof Parsed, keyof AgentFinding> = true;
const parsedIsFinding = (value: Parsed): AgentFinding => value;
const findingIsParsed = (value: AgentFinding): Parsed => value;
void [sameKeys, parsedIsFinding, findingIsParsed];
