/**
 * @lgtmoose/harness: runs a vendor's agent CLI headless on one review batch. The model gets
 * read-only tools on the checkout and returns JSON, which is validated with zod.
 */
export {
  EFFORT_LEVELS,
  HarnessError,
  MODEL_TIERS,
  fullPrompt,
  type EffortLevel,
  type Harness,
  type HarnessErrorKind,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessUsage,
  type ModelTier,
} from "./harness.js";
export {
  DEFAULT_COOLDOWN_MS,
  FallbackHarness,
  MemoryCooldownStore,
  summarizeUsage,
  type ChainProvider,
  type CooldownReason,
  type CooldownStore,
  type FallbackHarnessOptions,
  type FallbackResult,
  type ProviderAttempt,
  type ProviderUsageSummary,
} from "./fallback.js";
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
export {
  GOOGLE_CREDENTIALS_JSON,
  claudeAuthEnv,
  type ClaudeAuthEnv,
  type ClaudeAuthMethod,
} from "./claude-code/auth.js";
export {
  AgentSdkHarness,
  gitGuardHook,
  type AgentQuery,
  type AgentSdkHarnessOptions,
} from "./agent-sdk/adapter.js";
export {
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  isAllowedGitCommand,
  TOOLS,
} from "./claude-code/policy.js";
export {
  CODEX_DISABLED_FEATURES,
  CODEX_REASONING_EFFORT,
  CodexHarness,
  codexArgs,
  type CodexArgsOptions,
  type CodexHarnessOptions,
} from "./codex/adapter.js";
export { authJsonSecrets, codexAuth, type CodexAuth, type CodexAuthMethod } from "./codex/auth.js";
export {
  classifyFailure,
  classifyMachineSignals,
  classifyReportedFailure,
  isGenericError,
  limitTimes,
  type LimitFailure,
} from "./limits.js";
export { HeadTail } from "./headtail.js";
export { StreamRedactor } from "./redact.js";
export {
  CursorHarness,
  cursorArgs,
  MAX_CURSOR_ARG_PROMPT_BYTES,
  MAX_CURSOR_PROMPT_BYTES,
  type CursorArgsOptions,
  type CursorHarnessOptions,
} from "./cursor/adapter.js";
export { cursorAuth, type CursorAuth, type CursorAuthMethod } from "./cursor/auth.js";
export { CURSOR_DENIED_TOOLS, cursorPermissions, DENIED_ROOTS } from "./cursor/policy.js";
export { classifyCursorFailure } from "./cursor/result.js";
export { statusesIn } from "./status.js";
export { CURSOR_SKIPPED_DIRS, CURSOR_SKIPPED_FILES, copyWorkspace } from "./cursor/workspace.js";
export { isInside } from "./paths.js";
export {
  isGone,
  isUnreadable,
  joinBytes,
  walkTree,
  type TreeEntry,
  type WalkOptions,
} from "./tree.js";
export {
  CLAUDE_CODE_VERSION,
  CODEX_VERSION,
  CURSOR_AGENT_SHA256,
  CURSOR_AGENT_VERSION,
} from "./version.js";
