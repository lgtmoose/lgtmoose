/**
 * @lgtmoose/git: reviews work from a local checkout instead of GitHub's diff APIs, so there's no
 * pagination, no truncated patches and no compare limits.
 */
export { cloneAtSha, githubCloneUrl, type CloneOptions, type Repo } from "./clone.js";
export {
  diffCommits,
  reviewDiff,
  type DiffOptions,
  type FileDiff,
  type FileStatus,
  type ReviewDiff,
} from "./diff.js";
export { GitError } from "./exec.js";
export { importLines, languageOf } from "./imports.js";
export {
  parsePatch,
  unquotePath,
  type DiffLine,
  type FilePatch,
  type Hunk,
  type LineKind,
} from "./patch.js";
export { trackLine, trackLines, type LineRef } from "./track.js";
export {
  commentTarget,
  hunkFor,
  type CommentPosition,
  type CommentTarget,
  type Side,
  type TargetOptions,
} from "./position.js";
