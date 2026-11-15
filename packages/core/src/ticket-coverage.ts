import { z } from "zod";

/**
 * What the ticket checker returns for one ticket (NIC-839): the ticket's requirements as a
 * checklist, each judged against the pull request at head. It's model output over untrusted text
 * (the ticket) and the PR's code, so plain code decides what follows (`ticketGaps`): a missing
 * core requirement can count as a should-fix finding, never a blocking one, and a coverage
 * claim never approves anything on its own.
 *
 * Field names are snake_case like the finding's, and each has a description the model sees.
 */
export const REQUIREMENT_STATUSES = ["met", "partial", "missing", "unclear"] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const TICKET_COVERAGE_LIMITS = {
  requirements: 30,
  text: 300,
  evidence: 300,
  summary: 500,
} as const;

export const requirementSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(TICKET_COVERAGE_LIMITS.text)
      .describe("One requirement from the ticket, in a short plain sentence of your own."),
    core: z
      .boolean()
      .describe(
        "true for what the ticket must deliver: its acceptance criteria and its main ask. false for nice-to-haves, context, follow-ups and anything the ticket says is out of scope.",
      ),
    status: z
      .enum(REQUIREMENT_STATUSES)
      .describe(
        "met: the pull request's code at head does it. partial: it does some of it. missing: nothing in the pull request does it. unclear: you can't tell from the code.",
      ),
    evidence: z
      .string()
      .max(TICKET_COVERAGE_LIMITS.evidence)
      .optional()
      .describe(
        "Where the code does it (path:line), or what's missing. Plain text: no @-mentions, no links.",
      ),
  })
  .strict();

export type Requirement = z.infer<typeof requirementSchema>;

export const ticketCoverageSchema = z
  .object({
    requirements: z
      .array(requirementSchema)
      .max(TICKET_COVERAGE_LIMITS.requirements)
      .describe(
        `The ticket's requirements, most important first, at most ${TICKET_COVERAGE_LIMITS.requirements}. Empty if the ticket states none.`,
      ),
    summary: z
      .string()
      .max(TICKET_COVERAGE_LIMITS.summary)
      .optional()
      .describe("One or two plain sentences on how well the pull request covers the ticket."),
  })
  .strict();

export type TicketCoverageResult = z.infer<typeof ticketCoverageSchema>;

/** How much of a ticket's core the pull request covers, for the summary's table. */
export type CoverageLevel = "covered" | "partial" | "not_covered" | "unclear";

/** The most missing core requirements counted as should-fix findings in one review. */
export const MAX_TICKET_GAPS = 5;

/**
 * A ticket's coverage level: covered when every core requirement is met, not covered when none
 * is met or partly met, partial in between. Unclear when it has no core requirement the checker
 * could judge (none at all, or all unclear).
 */
export function coverageLevel(result: TicketCoverageResult): CoverageLevel {
  const judged = result.requirements.filter((req) => req.core && req.status !== "unclear");
  if (judged.length === 0) return "unclear";
  if (judged.every((req) => req.status === "met")) return "covered";
  if (judged.every((req) => req.status === "missing")) return "not_covered";
  return "partial";
}

/** A ticket's core requirements the checker found missing: candidates for should-fix gaps. */
export function missingCore(result: TicketCoverageResult): Requirement[] {
  return result.requirements.filter((req) => req.core && req.status === "missing");
}
