import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DescribeExecutionCommand, type SFNClient } from "@aws-sdk/client-sfn";
import {
  brokerCredentialsSchema,
  type BrokerCredential,
  type CredentialSecrets,
} from "./credentials.js";
import { errorName } from "./sfn.js";

/** The CloudWatch namespace of LGTMoose's own metrics. */
export const METRIC_NAMESPACE = "LGTMoose";
/** 1 while a provider's credential has a problem, 0 when a check finds none. */
export const CREDENTIAL_PROBLEM_METRIC = "CredentialProblem";

/** Provider credentials in Secrets Manager. Only `read` and `write` see a value. */
export function secretsManagerCredentials(client: SecretsManagerClient): CredentialSecrets {
  return {
    async describe(secretId) {
      let secret;
      try {
        secret = await client.send(new DescribeSecretCommand({ SecretId: secretId }));
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") {
          return {
            exists: false,
            deleting: false,
            currentVersion: undefined,
            currentSince: undefined,
          };
        }
        throw error;
      }
      const currentVersion = Object.entries(secret.VersionIdsToStages ?? {}).find(([, stages]) =>
        stages.includes("AWSCURRENT"),
      )?.[0];
      let currentSince: Date | undefined;
      if (currentVersion !== undefined) {
        const versions = await client.send(
          new ListSecretVersionIdsCommand({ SecretId: secretId, IncludeDeprecated: false }),
        );
        currentSince = versions.Versions?.find((v) => v.VersionId === currentVersion)?.CreatedDate;
      }
      return {
        exists: true,
        deleting: secret.DeletedDate !== undefined,
        currentVersion,
        currentSince,
      };
    },
    async read(secretId) {
      const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (SecretString === undefined) throw new Error(`Secret ${secretId} has no string value.`);
      return SecretString;
    },
    async write(secretId, value, requestToken) {
      const reply = await client.send(
        new PutSecretValueCommand({
          SecretId: secretId,
          SecretString: value,
          ClientRequestToken: requestToken,
        }),
      );
      if (reply.VersionId === undefined) throw new Error(`Secret ${secretId} got no version.`);
      return reply.VersionId;
    },
  };
}

/** Whether an execution is still running. One that doesn't exist (or isn't readable) isn't. */
export function executionRunning(client: SFNClient): (executionArn: string) => Promise<boolean> {
  return async (executionArn) => {
    try {
      const reply = await client.send(new DescribeExecutionCommand({ executionArn }));
      return reply.status === "RUNNING";
    } catch (error) {
      const name = errorName(error);
      if (name === "ExecutionDoesNotExist" || name === "InvalidArn") return false;
      throw error;
    }
  };
}

/** One JSON log line. Lines are the broker's audit log: they never hold a credential. */
export function logLine(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ message, ...fields })}\n`);
}

/**
 * Reports `CredentialProblem` for a provider as a CloudWatch embedded metric: a log line that
 * CloudWatch turns into the metric, so the Lambda needs no PutMetricData permission.
 */
export function reportProblem(providerId: string, value: 0 | 1, reason?: string): void {
  logLine(value === 1 ? "credential problem" : "credential ok", {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [["Provider"]],
          Metrics: [{ Name: CREDENTIAL_PROBLEM_METRIC, Unit: "Count" }],
        },
      ],
    },
    Provider: providerId,
    [CREDENTIAL_PROBLEM_METRIC]: value,
    ...(reason === undefined ? {} : { reason }),
  });
}

/** The credentials the broker Lambdas manage, from `LGTMOOSE_CREDENTIALS` (set by the stack). */
export function credentialsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, BrokerCredential> {
  const raw = env.LGTMOOSE_CREDENTIALS;
  if (raw === undefined || raw.trim() === "") throw new Error("LGTMOOSE_CREDENTIALS is not set.");
  return brokerCredentialsSchema.parse(JSON.parse(raw));
}
