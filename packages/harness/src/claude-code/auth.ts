import { HarnessError } from "../harness.js";

/** How the CLI reaches the model, picked from the environment. */
export type ClaudeAuthMethod = "bedrock" | "vertex" | "api_key" | "oauth_token";

export interface ClaudeAuthEnv {
  method: ClaudeAuthMethod;
  /** Only the variables this method needs. */
  env: Record<string, string>;
  /** Values to keep out of transcripts, errors and output. */
  secrets: string[];
}

type Source = Readonly<Record<string, string | undefined>>;

const BEDROCK_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  // A Fargate or ECS task role.
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_STS_REGIONAL_ENDPOINTS",
];

const VERTEX_VARS = [
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
];
/** Per-model region overrides, such as VERTEX_REGION_CLAUDE_4_5_SONNET. */
const VERTEX_PREFIX = "VERTEX_REGION_";

/** Model aliases and the base URL of an LLM gateway. Used by every method. */
const COMMON_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
];

/** Variables whose values are credentials. */
const SECRET_VARS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
]);

function isOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

function pick(source: Source, names: readonly string[], prefix?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === "") continue;
    if (names.includes(name) || (prefix !== undefined && name.startsWith(prefix))) {
      out[name] = value;
    }
  }
  return out;
}

function withSecrets(method: ClaudeAuthMethod, env: Record<string, string>): ClaudeAuthEnv {
  const secrets = Object.entries(env)
    .filter(([name]) => SECRET_VARS.has(name))
    .map(([, value]) => value);
  return { method, env, secrets };
}

/**
 * Picks the model credential from the environment, in Claude Code's order: Bedrock, then
 * Vertex, then an API key, then an OAuth token from `claude setup-token`. Returns only the
 * variables that method needs, so nothing else from this process reaches the CLI.
 */
export function claudeAuthEnv(source: Source): ClaudeAuthEnv {
  const common = pick(source, COMMON_VARS);

  if (isOn(source.CLAUDE_CODE_USE_BEDROCK)) {
    const env = { ...common, ...pick(source, BEDROCK_VARS) };
    if (!env.AWS_REGION) {
      throw new HarnessError(
        "auth",
        "Bedrock is selected (CLAUDE_CODE_USE_BEDROCK) but AWS_REGION is not set.",
      );
    }
    return withSecrets("bedrock", env);
  }

  if (isOn(source.CLAUDE_CODE_USE_VERTEX)) {
    const env = { ...common, ...pick(source, VERTEX_VARS, VERTEX_PREFIX) };
    const missing = ["ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"].filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new HarnessError(
        "auth",
        `Vertex is selected (CLAUDE_CODE_USE_VERTEX), so ${missing.join(" and ")} must be set.`,
      );
    }
    return withSecrets("vertex", env);
  }

  // In print mode Claude Code prefers an API key over an OAuth token, so pass only one.
  if (source.ANTHROPIC_API_KEY) {
    return withSecrets("api_key", { ...common, ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY });
  }
  if (source.CLAUDE_CODE_OAUTH_TOKEN) {
    return withSecrets("oauth_token", {
      ...common,
      CLAUDE_CODE_OAUTH_TOKEN: source.CLAUDE_CODE_OAUTH_TOKEN,
    });
  }

  throw new HarnessError(
    "auth",
    "No model credential found. Set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK with AWS credentials and AWS_REGION, or CLAUDE_CODE_USE_VERTEX with Google credentials.",
  );
}

/** Network settings the sandbox may need to reach the model API through its egress proxy. */
export const NETWORK_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];

export function networkEnv(source: Source): Record<string, string> {
  return pick(source, NETWORK_VARS);
}
