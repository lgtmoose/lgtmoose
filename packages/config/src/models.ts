import type { ProviderConfig, Tier } from "./deploy.js";

/**
 * Claude Code's model aliases, with an optional `[1m]`-style modifier. They resolve inside the
 * CLI, on Bedrock and Vertex to its own built-in model IDs.
 */
const ALIAS = /^(?:default|best|opus|sonnet|haiku|opusplan)(?:\[[\w-]+\])?$/;

/** Whether a configured model is a Claude Code alias rather than a pinned model ID. */
export function isModelAlias(model: string): boolean {
  return ALIAS.test(model);
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
