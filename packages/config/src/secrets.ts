import type { ProviderConfig } from "./deploy.js";

/**
 * Secrets Manager names. `lgtmoose setup` and `lgtmoose auth` write these; the CDK stacks only
 * reference them, so a redeploy never overwrites a credential.
 */
export const SECRET_NAMES = {
  /** JSON: { appId, privateKey, clientId, clientSecret } */
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
