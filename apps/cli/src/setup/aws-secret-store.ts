import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type { SetupSecretStore } from "./secret-store.js";

/** The subset of SecretsManagerClient we use, so tests can fake `send`. */
export interface SecretsManagerSender {
  send(
    command: CreateSecretCommand | GetSecretValueCommand | PutSecretValueCommand,
  ): Promise<{ SecretString?: string | undefined }>;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** SetupSecretStore on AWS Secrets Manager. Kept apart so `setup --help` doesn't load the AWS SDK. */
export function awsSecretStore(client: SecretsManagerSender, region: string): SetupSecretStore {
  // AWS error messages name the secret but never contain its value, so they're safe to show.
  const context = (name: string, error: unknown) => {
    const hint =
      errorName(error) === "CredentialsProviderError"
        ? " Sign in to AWS first (for example `aws sso login`), then try again."
        : "";
    const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
    return new Error(`AWS Secrets Manager (${region}) failed on ${name}: ${message}.${hint}`, {
      cause: error,
    });
  };

  return {
    async read(name) {
      try {
        const output = await client.send(new GetSecretValueCommand({ SecretId: name }));
        return output.SecretString;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return undefined;
        throw context(name, error);
      }
    },
    async write(name, value, description) {
      try {
        await client.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: value,
            Description: description,
            Tags: [{ Key: "app", Value: "lgtmoose" }],
          }),
        );
        return "created";
      } catch (error) {
        if (errorName(error) !== "ResourceExistsException") throw context(name, error);
      }
      try {
        await client.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
        return "updated";
      } catch (error) {
        throw context(name, error);
      }
    },
  };
}

export function createAwsSecretStore(region: string): SetupSecretStore {
  return awsSecretStore(new SecretsManagerClient({ region }), region);
}
