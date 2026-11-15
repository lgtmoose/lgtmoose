import type { ProviderConfig } from "./deploy.js";

/**
 * Secrets Manager names. `lgtmoose setup` and `lgtmoose auth` write these; the CDK stacks only
 * reference them, so a redeploy never overwrites a credential.
 *
 * The names are fixed, so one AWS account and region holds one LGTMoose install: a second
 * install there would overwrite the first one's App credentials. NIC-852 adds a deployment
 * name to lift that.
 */
export const SECRET_NAMES = {
  /** JSON: { appId, slug, privateKey, clientId, clientSecret, webhookSecretSha256 } */
  githubApp: "lgtmoose/github-app",
  /**
   * The webhook HMAC secret, as plain text. Kept apart from the App's private key so the
   * internet-facing gateway can verify deliveries without being able to act as the App.
   */
  githubWebhook: "lgtmoose/github-webhook-secret",
  /**
   * JSON: { clientId, clientSecret }, the App's OAuth client for the dashboard's sign-in. A copy
   * kept apart from `githubApp`, so the dashboard API can sign people in without being able to
   * act as the App. `lgtmoose deploy` copies it from `githubApp` when the dashboard is on, and
   * again whenever the App's client changes.
   */
  githubAppOAuth: "lgtmoose/github-app-oauth",
  /**
   * One per provider that needs a stored credential, written by `lgtmoose auth`. The value is
   * the credential as plain text, exactly what the sandbox reads from
   * `LGTMOOSE_PROVIDER_CREDENTIAL`: a token or key, or for a Codex ChatGPT sign-in the whole
   * `auth.json`. Tagged with `PROVIDER_CREDENTIAL_TAGS`. See docs/credentials.md.
   */
  provider: (providerId: string) => `${PROVIDER_SECRET_PREFIX}${providerId}`,
  /**
   * The OpenAI API key for learnings embeddings (`learnings.embeddings.provider: openai`), as
   * plain text. Read by the control task only; sandbox tasks never see it.
   */
  openAiEmbeddings: "lgtmoose/embeddings/openai",
  /**
   * The Linear API key for ticket coverage (`tickets.provider: linear`), as plain text, written
   * by `lgtmoose auth linear`. Read by the control task only; sandbox tasks never see it.
   */
  linearTickets: "lgtmoose/tickets/linear",
} as const;

/** Every provider credential's name starts with this, so they can be listed together. */
export const PROVIDER_SECRET_PREFIX = "lgtmoose/provider/";

/**
 * Tag keys on each provider credential. They describe the secret without its value, so the
 * credential broker and `lgtmoose auth list` can tell what a secret holds without reading it.
 */
export const PROVIDER_CREDENTIAL_TAGS = {
  /** Always `lgtmoose`, on every secret LGTMoose writes. */
  app: "app",
  /** Always `PROVIDER_CREDENTIAL_KIND`. */
  kind: "lgtmoose:kind",
  /** The provider's `id` in lgtmoose.config.ts. */
  provider: "lgtmoose:provider",
  /** Its `harness`, such as `codex`. */
  harness: "lgtmoose:harness",
  /** Its `auth`, such as `chatgpt-login`. */
  auth: "lgtmoose:auth",
} as const;

export const PROVIDER_CREDENTIAL_KIND = "provider-credential";

/** Bedrock uses the task's IAM role; every other auth method needs a stored credential. */
export function providerNeedsSecret(provider: Pick<ProviderConfig, "auth">): boolean {
  return provider.auth !== "bedrock";
}
