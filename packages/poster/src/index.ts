/**
 * @lgtmoose/poster: posts a review run to GitHub. One review with inline comments (positions
 * from @lgtmoose/git; findings outside the diff go into the body), the LGTMoose check run with
 * annotations, the summary comment edited in place, and the status-label calls. Shadow mode
 * records the same calls to an object store and the log instead.
 */
export { appJwt, installationTokenProvider, type InstallationTokenOptions } from "./app-auth.js";
export {
  GitHubClient,
  GitHubError,
  repoPath,
  type GitHubClientOptions,
  type PullRef,
  type TokenProvider,
} from "./github.js";
export {
  GITHUB_BODY_LIMIT,
  findingHeading,
  findingLocation,
  formatComment,
  suggestionBlock,
} from "./format.js";
export {
  buildReview,
  reviewBody,
  reviewMarkerComment,
  withCommentsInBody,
  type ReviewComment,
  type ReviewInput,
  type ReviewPayload,
} from "./review.js";
export {
  ANNOTATIONS_PER_REQUEST,
  CHECK_NAME,
  annotationPages,
  annotationsFor,
  checkOutput,
  type Annotation,
  type AnnotationLevel,
  type CheckRunInput,
} from "./check-run.js";
export {
  GitHubLabelClient,
  GitHubPoster,
  type GitHubPosterOptions,
  type MarkedReview,
  type PostedReview,
  type Poster,
  type SummaryCommentResult,
} from "./poster.js";
export {
  ShadowPoster,
  type ObjectStore,
  type ShadowLog,
  type ShadowPosterOptions,
} from "./shadow.js";
