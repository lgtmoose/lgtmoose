/**
 * @lgtmoose/core holds the deterministic parts of a review: no model calls, no I/O.
 * The finding schema (NIC-808) and the review decision (NIC-815) are here; fingerprints
 * (NIC-814) land here next.
 */

export { SEVERITIES, isSeverity, severityRank, type Severity } from "./severity.js";
export {
  DEFAULT_DECISION_CONFIG,
  countFindings,
  decide,
  type CheckConclusion,
  type DecisionConfig,
  type DecisionContext,
  type DecisionOutcome,
  type FindingCounts,
  type HoldReason,
  type OpenFinding,
  type ReviewDecision,
  type ReviewEvent,
} from "./decision.js";
export {
  FINDING_LIMITS,
  SIDES,
  findingSchema,
  keepMostSevere,
  reviewerOutputSchema,
  type Finding,
  type FindingSide,
  type ReviewerOutput,
} from "./finding.js";
export {
  REVIEW_JOB_KINDS,
  SKIP_LABEL,
  isReviewJobKind,
  reviewJobGroupId,
  toReviewJob,
  type Ignored,
  type ReviewJob,
  type ReviewJobKind,
  type ToReviewJobOptions,
} from "./review-job.js";
