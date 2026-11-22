import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  GetFoundationModelCommand,
  GetInferenceProfileCommand,
} from "@aws-sdk/client-bedrock";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { bedrockModelApi } from "@lgtmoose/config";
import { checkCredentials } from "./credentials.js";
import {
  credentialsFromEnv,
  logLine,
  reportModel,
  reportProblem,
  secretsManagerCredentials,
} from "./credentials-aws.js";
import { checkModels, modelChecksSchema } from "./model-health.js";

const secrets = new SecretsManagerClient({});

/**
 * The scheduled health check: describes each provider's secret (never reads its value) and
 * reports `CredentialProblem` for it (see `checkCredentials`), then asks Bedrock whether each
 * pinned Bedrock model can be called and reports `ModelUnavailable` (see `checkModels`).
 */
export async function handler(): Promise<{
  credentials: Record<string, string | undefined>;
  models: Record<string, string>;
}> {
  const credentials = await checkCredentials({
    secrets: secretsManagerCredentials(secrets),
    credentials: credentialsFromEnv(process.env),
    now: Date.now,
    problem: reportProblem,
  });
  const checks = modelChecksSchema.parse(JSON.parse(process.env.LGTMOOSE_MODEL_CHECKS ?? "[]"));
  const region = process.env.AWS_REGION ?? "";
  const results =
    checks.length === 0
      ? []
      : await checkModels({
          checks,
          region,
          bedrock: bedrockModelApi({
            client: new BedrockClient({ region }),
            GetInferenceProfileCommand,
            GetFoundationModelCommand,
            GetFoundationModelAvailabilityCommand,
          }),
          report: reportModel,
          log: logLine,
        });
  return {
    credentials,
    models: Object.fromEntries(
      results.map((result) => [`${result.providerId}:${result.model}`, result.status]),
    ),
  };
}
