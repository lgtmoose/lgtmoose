import { z } from "zod";
import type { AgentFinding, RunDecision } from "./agent-markdown.js";

/**
 * A pull request's open findings as the findings API returns them (NIC-1140), and answers to
 * them. The markdown for a coding agent is in `agent-markdown.ts`, which has no zod, so the
 * dashboard can bundle it for the browser.
 */

export {
  agentFindingsMarkdown,
  countsNote,
  decisionCounts,
  decisionLine,
  outcomeLabel,
  plainLine,
  type AgentFinding,
  type RunDecision,
  type RunHold,
  type RunOutcome,
} from "./agent-markdown.js";

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

/** What a review run decided (NIC-1145). */
export const runOutcomes = ["approve", "request_changes", "comment"] as const;

/** A commit SHA: hex only, so it can't carry anything else into the output. */
const commitSha = z.string().regex(/^[0-9a-f]{7,40}$/);
const count = z.number().int().nonnegative();

/** A pull request's latest decision, as the findings API gives it (NIC-1145). */
export const runDecisionSchema = z.object({
  /** The run's ID: a UUID. */
  runId: z.uuid(),
  /** The commit it reviewed. */
  headSha: commitSha,
  decision: z.enum(runOutcomes),
  /** The open findings it counted, by severity; absent for a run from before they were kept. */
  blocking: count.optional(),
  shouldFix: count.optional(),
  nits: count.optional(),
  /** In shadow mode: nothing was posted to GitHub. */
  shadow: z.boolean(),
  /** What kept it from approving, apart from findings; absent when that wasn't kept. */
  holds: z.array(z.enum(["incomplete", "prompt_injection", "approve_disabled"])).optional(),
  finishedAt: z.string().optional(),
});

// As for findings: the schema and the plain `RunDecision` the browser bundle uses must match.
type ParsedDecision = z.infer<typeof runDecisionSchema>;
const sameDecisionKeys: Same<keyof ParsedDecision, keyof RunDecision> = true;
const parsedIsDecision = (value: ParsedDecision): RunDecision => value;
const decisionIsParsed = (value: RunDecision): ParsedDecision => value;
void [sameDecisionKeys, parsedIsDecision, decisionIsParsed];

/** One review run of a pull request, as `GET /api/runs` lists it (NIC-1145). */
export const agentRunSchema = z.object({
  id: z.uuid(),
  headSha: commitSha,
  kind: z.string(),
  status: z.string(),
  /** What it decided; absent for a run that recorded no decision (covered, failed, older). */
  decision: z.enum(runOutcomes).optional(),
  blocking: count.optional(),
  shouldFix: count.optional(),
  nits: count.optional(),
  /** In shadow mode; absent for a run that decided nothing, whose mode may not be its own. */
  shadow: z.boolean().optional(),
  costUsd: z.number().optional(),
  /** When it started; absent for one that never did (queued, or superseded first). */
  startedAt: z.string().optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;
