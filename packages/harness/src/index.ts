/**
 * @lgtmoose/harness: runs a vendor's agent CLI headless on one review batch. The model gets
 * read-only tools on the checkout and returns JSON, which is validated with zod.
 */
export {
  HarnessError,
  MODEL_TIERS,
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
export { claudeAuthEnv, type ClaudeAuthEnv, type ClaudeAuthMethod } from "./claude-code/auth.js";
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
export { classifyFailure, type LimitFailure } from "./codex/stream.js";
export {
  CursorHarness,
  cursorArgs,
  MAX_CURSOR_PROMPT_BYTES,
  type CursorArgsOptions,
  type CursorHarnessOptions,
} from "./cursor/adapter.js";
export { cursorAuth, type CursorAuth, type CursorAuthMethod } from "./cursor/auth.js";
export {
  CURSOR_PERMISSIONS,
  CURSOR_PROJECT_CONFIG_DIRS,
  cursorPermissions,
} from "./cursor/policy.js";
export { classifyCursorFailure } from "./cursor/result.js";
export { CLAUDE_CODE_VERSION, CODEX_VERSION, CURSOR_AGENT_VERSION } from "./version.js";
