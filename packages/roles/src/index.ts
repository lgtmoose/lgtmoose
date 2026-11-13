/**
 * @lgtmoose/roles: the agent roles' prompts. A role turns a batch of diffs, the PR's text, the
 * repo's conventions and the selected rule packs into one prompt. The model reads it and
 * returns findings as JSON; plain code does the rest.
 */
export {
  readConventionFiles,
  type ConventionFile,
  type ConventionFiles,
  type ReadConventionsOptions,
} from "./conventions.js";
export { placeFindings, type PlacedFindings } from "./placement.js";
export {
  formatRanges,
  renderBatch,
  renderBatchFile,
  type BatchFile,
  type ReviewBatch,
  type ReviewDepth,
} from "./diff.js";
export {
  buildReviewerPrompt,
  type PullRequestComment,
  type PullRequestInfo,
  type ReviewerPromptInput,
} from "./reviewer.js";
export {
  CROSS_FILE_LIMITS,
  CROSS_FILE_TIER,
  buildCrossFilePrompt,
  collectBatchNotes,
  type BatchNotes,
  type CrossFilePromptInput,
  type ReviewedBatch,
  type SkippedPath,
} from "./cross-file.js";
export {
  RULE_PACK_DIR,
  RulePackError,
  availableRulePacks,
  loadRulePack,
  loadRulePacks,
  type RulePack,
} from "./rule-packs.js";
export {
  UNTRUSTED_TAG,
  escapeAttribute,
  escapeUntrusted,
  wrapUntrusted,
  type UntrustedAttributes,
} from "./untrusted.js";
export {
  FINDING_LIMITS,
  findingSchema,
  reviewerOutputSchema,
  type Finding,
  type ReviewerOutput,
} from "@lgtmoose/core";
