/**
 * @lgtmoose/pipeline: one whole review of a PR, run in this process without posting anything:
 * clone, plan, a reviewer run per batch, placement, duplicate checks, the decision and the
 * summary. The CLI's `review --dry-run` and the evals run it whole; the review workflow runs its
 * stages in separate tasks (prepare, one batch per sandbox, finish).
 */
export {
  finishReview,
  prepareReview,
  runBatch,
  runJudge,
  runTicketCheck,
  reviewedBlobOf,
  runReview,
  type TicketOutcome,
  type TicketReview,
  type BatchJob,
  type BatchOutcome,
  type BatchReport,
  type DroppedReport,
  type EarlierFinding,
  type FinishOptions,
  type JudgeOutcome,
  type LearningsForBatch,
  type PrepareDeps,
  type PrepareOptions,
  type PreparedReview,
  type ResumedWork,
  type StoredSeverity,
  type ReviewedBlob,
  type ReviewedFile,
  type ReviewDeps,
  type ReviewOptions,
  type ReviewReport,
  type RunBatchOptions,
} from "./pipeline.js";
export type { PullComment, PullReader, PullRequest, PullTarget } from "./pull.js";
export { githubPullReader, type GitHubGet } from "./github-reader.js";
export {
  otherReviewerFindings,
  otherReviewerSeverity,
  reviewerMisses,
  type OtherReviewerFinding,
  type OtherReviewerOptions,
  type ReviewerMiss,
} from "./other-reviewers.js";
export {
  RUN_PREFIX,
  FALLBACK_ERROR_KINDS,
  TRANSCRIPT_ATTEMPTS,
  assertRunId,
  batchInputSchema,
  batchOutputSchema,
  batchRunId,
  batchTranscriptKeys,
  batchUrlsSchema,
  headKeys,
  runKeys,
  wantsFallback,
  type BatchInput,
  type BatchOutput,
  type BatchUrls,
} from "./workflow.js";
export { FileTranscriptStore } from "./transcripts.js";
export {
  INJECTION_CATEGORY,
  MAX_INJECTION_FINDINGS,
  describeKinds,
  detectInjection,
  scanText,
  type InjectionKind,
  type InjectionScan,
  type InjectionSource,
  type TextInjection,
} from "./injection.js";
