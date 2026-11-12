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
  /** One per provider that needs a stored credential. */
  provider: (providerId: string) => `lgtmoose/provider/${providerId}`,
} as const;

/** Bedrock uses the task's IAM role; every other auth method needs a stored credential. */
export function providerNeedsSecret(provider: Pick<ProviderConfig, "auth">): boolean {
  return provider.auth !== "bedrock";
}
