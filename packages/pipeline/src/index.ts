/**
 * @lgtmoose/pipeline: one whole review of a PR, run in this process without posting anything:
 * clone, plan, a reviewer run per batch, placement, duplicate checks, the decision and the
 * summary. The CLI's `review --dry-run` and the evals run it.
 */
export {
  runReview,
  type BatchReport,
  type DroppedReport,
  type ReviewDeps,
  type ReviewOptions,
  type ReviewReport,
} from "./pipeline.js";
export type { PullComment, PullReader, PullRequest, PullTarget } from "./pull.js";
export { FileTranscriptStore } from "./transcripts.js";
