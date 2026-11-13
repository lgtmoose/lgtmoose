/**
 * @lgtmoose/harness: runs a vendor's agent CLI headless on one review batch. The model gets
 * read-only tools on the checkout and returns JSON, which is validated with zod.
 */
export {
  HarnessError,
  type Harness,
  type HarnessErrorKind,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessUsage,
} from "./harness.js";
export {
  MemoryTranscriptStore,
  S3TranscriptStore,
  transcriptKey,
  type S3Sender,
  type S3TranscriptStoreOptions,
  type TranscriptStore,
} from "./transcript.js";
export {
  ClaudeCodeHarness,
  claudeArgs,
  type ClaudeArgsOptions,
  type ClaudeCodeHarnessOptions,
} from "./claude-code/adapter.js";
export { claudeAuthEnv, type ClaudeAuthEnv, type ClaudeAuthMethod } from "./claude-code/auth.js";
export {
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  isAllowedGitCommand,
  TOOLS,
} from "./claude-code/policy.js";
export { CLAUDE_CODE_VERSION } from "./version.js";
