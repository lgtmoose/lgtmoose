/**
 * @lgtmoose/roles: the agent roles' prompts. A role turns a batch of diffs, the PR's text, the
 * repo's conventions and the selected rule packs into one prompt. The model reads it and
 * returns JSON (the reviewer's findings, the verifier's verdicts); plain code does the rest.
 */
export {
  readConventionFiles,
  readConventionFilesAt,
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
  buildReviewerParts,
  buildReviewerPrompt,
  renderLearnings,
  type PromptLearning,
  type ReviewerPromptParts,
  type PullRequestComment,
  type PullRequestInfo,
  type ReviewerPromptInput,
} from "./reviewer.js";
export {
  DEFAULT_EXCERPT_CONTEXT,
  DEFAULT_NITS_PER_RUN,
  VERIFIER_TIER,
  applyVerdicts,
  buildVerifierPrompt,
  codeExcerpt,
  verifierRuns,
  type AppliedVerdicts,
  type CodeExcerpt,
  type DroppedFinding,
  type VerifierPromptInput,
  type VerifyTarget,
} from "./verifier.js";
export {
  TICKET_CHECKER_TIER,
  buildTicketCoveragePrompt,
  type CheckedTicket,
  type TicketCoverageInput,
} from "./ticket-coverage.js";
export {
  REPLY_JUDGE_TIER,
  buildReplyJudgePrompt,
  type JudgedFinding,
  type ReplyJudgeInput,
} from "./reply-judge.js";
export {
  CROSS_FILE_LIMITS,
  CROSS_FILE_TIER,
  buildCrossFilePrompt,
  clipBatchNotes,
  collectBatchNotes,
  type BatchNotes,
  type CrossFilePromptInput,
  type ReviewedBatch,
  type SkippedPath,
} from "./cross-file.js";
export {
  MANDATORY_RULE_PACKS,
  PRIVATE_RULE_PACK_DIR,
  REPO_RULE_PACK_LIMITS,
  RULE_PACK_DIR,
  RulePackError,
  availableRulePacks,
  loadRulePack,
  loadRulePacks,
  parseRulePack,
  selectRulePacks,
  type PackRule,
  type RulePack,
  type RulePackDirs,
  type RulePackSource,
  type SelectRulePacksOptions,
  type SelectedRulePacks,
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
  verifierOutputSchema,
  type Finding,
  type ReviewerOutput,
  type Verdict,
  type VerifierOutput,
} from "@lgtmoose/core";
