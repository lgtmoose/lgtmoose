import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { checkCredentials } from "./credentials.js";
import { credentialsFromEnv, reportProblem, secretsManagerCredentials } from "./credentials-aws.js";

const secrets = new SecretsManagerClient({});

/**
 * The scheduled credential health check: describes each provider's secret (never reads its
 * value) and reports `CredentialProblem` for it. See `checkCredentials`.
 */
export async function handler(): Promise<Record<string, string | undefined>> {
  return checkCredentials({
    secrets: secretsManagerCredentials(secrets),
    credentials: credentialsFromEnv(process.env),
    now: Date.now,
    problem: reportProblem,
  });
}
