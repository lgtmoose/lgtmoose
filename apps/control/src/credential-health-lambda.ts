import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { bedrockClientOptions, bedrockModelApi, type BedrockModelApi } from "@lgtmoose/config";
import { checkCredentials } from "./credentials.js";
import {
  credentialsFromEnv,
  logLine,
  reportModel,
  reportProblem,
  secretsManagerCredentials,
} from "./credentials-aws.js";
import { healthCheck, modelChecksSchema } from "./model-health.js";

const secrets = new SecretsManagerClient({});

/**
 * Bedrock's control plane, from the Lambda runtime's own `@aws-sdk/client-bedrock` (the SDK is
 * left out of the bundle). Loaded only when a model is checked, so a runtime whose client lacks
 * a command fails the model check alone, never the module or the credential check.
 */
async function loadBedrock(region: string): Promise<BedrockModelApi> {
  const sdk = await import("@aws-sdk/client-bedrock");
  const {
    BedrockClient,
    GetInferenceProfileCommand,
    GetFoundationModelCommand,
    GetFoundationModelAvailabilityCommand,
  } = sdk;
  for (const [name, command] of Object.entries({
    BedrockClient,
    GetInferenceProfileCommand,
    GetFoundationModelCommand,
    GetFoundationModelAvailabilityCommand,
  })) {
    if (typeof command !== "function") throw new Error(`@aws-sdk/client-bedrock has no ${name}.`);
  }
  return bedrockModelApi({
    client: new BedrockClient(bedrockClientOptions(region)),
    GetInferenceProfileCommand,
    GetFoundationModelCommand,
    GetFoundationModelAvailabilityCommand,
  });
}

/**
 * The scheduled health check: describes each provider's secret (never reads its value) and
 * reports `CredentialProblem` for it (see `checkCredentials`), then asks Bedrock whether each
 * pinned Bedrock model can be called and reports `ModelUnavailable` (see `healthCheck`).
 */
export async function handler(
  _event?: unknown,
  context?: { getRemainingTimeInMillis(): number },
): Promise<{
  credentials: Record<string, string | undefined>;
  models: Record<string, string>;
}> {
  const region = process.env.AWS_REGION ?? "";
  return healthCheck({
    credentials: () =>
      checkCredentials({
        secrets: secretsManagerCredentials(secrets),
        credentials: credentialsFromEnv(process.env),
        now: Date.now,
        problem: reportProblem,
      }),
    checks: () => modelChecksSchema.parse(JSON.parse(process.env.LGTMOOSE_MODEL_CHECKS ?? "[]")),
    region,
    bedrock: () => loadBedrock(region),
    report: reportModel,
    log: logLine,
    ...(context === undefined ? {} : { remainingMs: () => context.getRemainingTimeInMillis() }),
  });
}
