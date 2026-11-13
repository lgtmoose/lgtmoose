/**
 * @lgtmoose/core holds the deterministic parts of a review: no model calls, no I/O.
 * The finding schema (NIC-808), finding fingerprints with convergence dedupe (NIC-814), the
 * review decision (NIC-815) and the verifier's verdict schema (NIC-829) are here.
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
  crossFileOutputSchema,
  findingSchema,
  keepMostSevere,
  reviewerOutputSchema,
  type CrossFileOutput,
  type Finding,
  type FindingSide,
  type ReviewerOutput,
} from "./finding.js";
export {
  FINGERPRINT_VERSION,
  FUZZY_CODE_SIMILARITY,
  FUZZY_NOUN_SIMILARITY,
  PROTECTED_CATEGORIES,
  citedCode,
  codeOccurrence,
  commentTitle,
  dedupeFindings,
  fingerprint,
  fingerprintParts,
  isProtectedCategory,
  isSimilar,
  normalizeCode,
  titleNouns,
  type Candidate,
  type DedupeResult,
  type DroppedFinding,
  type FingerprintParts,
  type FingerprintSubject,
  type KnownFinding,
} from "./fingerprint.js";
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
export {
  MAX_FINDINGS_PER_VERIFIER_RUN,
  verdictSchema,
  verifierOutputSchema,
  type Verdict,
  type VerifierOutput,
} from "./verdict.js";
