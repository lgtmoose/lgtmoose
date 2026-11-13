/**
 * @lgtmoose/core holds the deterministic parts of a review: no model calls, no I/O.
 * The finding schema (NIC-808) and finding fingerprints with convergence dedupe (NIC-814) are
 * here; the review decision (NIC-815) lands here next.
 */

export { SEVERITIES, isSeverity, severityRank, type Severity } from "./severity.js";
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
  FINGERPRINT_VERSION,
  FUZZY_CODE_SIMILARITY,
  FUZZY_NOUN_SIMILARITY,
  PROTECTED_CATEGORIES,
  citedCode,
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
