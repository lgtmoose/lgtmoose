import type { ProviderConfig, Tier } from "./deploy.js";

/**
 * Claude Code's model aliases and the model families they follow. An alias may carry a
 * `[1m]`-style modifier. Claude Code (or an ANTHROPIC_DEFAULT_*_MODEL override) resolves it at
 * runtime, on Bedrock and Vertex to its own built-in model IDs.
 */
export const MODEL_ALIAS_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  haiku: ["haiku"],
  sonnet: ["sonnet"],
  opus: ["opus"],
  best: ["opus"],
  // Plans with Opus and works with Sonnet.
  opusplan: ["opus", "sonnet"],
};

/** Claude Code's `[1m]`-style modifier at the end of a model name. */
export const MODEL_MODIFIER = /\[[^\]]*\]$/;

/**
 * A Bedrock model ID, bare (`anthropic.…`) or through a cross-region inference profile
 * (`us.anthropic.…`): group 1 is the profile prefix, group 2 the foundation model.
 */
export const BEDROCK_MODEL_ID = /^(?:([a-z-]+)\.)?(anthropic\..+)$/;

/** Whether a configured model is a Claude Code alias rather than a pinned model ID. */
export function isModelAlias(model: string): boolean {
  const name = model.replace(MODEL_MODIFIER, "");
  // `default` is Claude Code's own pick for the account.
  return name === "default" || Object.hasOwn(MODEL_ALIAS_FAMILIES, name);
}

/**
 * Which alias variable a tier's pinned model steers. Claude Code reads
 * `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` for its aliases and for its background
 * (small and fast) model, which uses the Haiku pin
 * (https://code.claude.com/docs/en/amazon-bedrock#4-pin-model-versions).
 */
const TIER_VARIABLE: Record<Tier, string> = {
  fast: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  standard: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  deep: "ANTHROPIC_DEFAULT_OPUS_MODEL",
};

/**
 * The model settings a provider's sandbox task gets, as environment variables, for the Claude
 * harnesses on Bedrock and Vertex:
 * - each tier pinned to a model ID (not an alias) steers the matching alias variable, so the
 *   CLI's background model and any alias it falls back to use the pinned models too;
 * - Vertex gets its region and, when configured, its project.
 *
 * Empty for every other provider: an API key reaches Anthropic's own model IDs, and Codex and
 * Cursor take the model on their command line.
 */
export function providerModelEnv(provider: ProviderConfig): Record<string, string> {
  if (provider.harness !== "claude-code" && provider.harness !== "agent-sdk") return {};
  if (provider.auth !== "bedrock" && provider.auth !== "vertex") return {};
  const env: Record<string, string> = {};
  for (const [tier, variable] of Object.entries(TIER_VARIABLE) as [Tier, string][]) {
    const model = provider.models?.[tier];
    if (model !== undefined && !isModelAlias(model)) env[variable] = model;
  }
  if (provider.auth === "vertex") {
    env.CLOUD_ML_REGION = provider.vertex?.region ?? "global";
    if (provider.vertex?.projectId !== undefined) {
      env.ANTHROPIC_VERTEX_PROJECT_ID = provider.vertex.projectId;
    }
  }
  return env;
}

/**
 * The Vertex AI host for a region: the global endpoint, a multi-region endpoint, or a regional
 * one (https://code.claude.com/docs/en/google-vertex-ai).
 */
export function vertexHost(region: string): string {
  if (region === "global") return "aiplatform.googleapis.com";
  if (region === "us" || region === "eu") return `aiplatform.${region}.rep.googleapis.com`;
  return `${region}-aiplatform.googleapis.com`;
}
