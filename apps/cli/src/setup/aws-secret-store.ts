import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { awsError, errorName, isScheduledForDeletion } from "../aws-errors.js";
import { SecretScheduledForDeletion, type SetupSecretStore } from "./secret-store.js";

/** The subset of SecretsManagerClient we use, so tests can fake `send`. */
export interface SecretsManagerSender {
  send(
    command: CreateSecretCommand | GetSecretValueCommand | PutSecretValueCommand,
  ): Promise<{ SecretString?: string | undefined }>;
}

/** SetupSecretStore on AWS Secrets Manager. Kept apart so `setup --help` doesn't load the AWS SDK. */
export function awsSecretStore(client: SecretsManagerSender, region: string): SetupSecretStore {
  const context = (name: string, error: unknown) =>
    awsError("Secrets Manager", region, name, error);

  return {
    async read(name) {
      try {
        const output = await client.send(new GetSecretValueCommand({ SecretId: name }));
        return output.SecretString;
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return undefined;
        // Not "missing": a writer can't create it until it's restored, so setup must stop
        // before making anything that it would then fail to store. Deploy's provider check
        // decides for itself what this means.
        if (isScheduledForDeletion(error)) throw new SecretScheduledForDeletion(name, region);
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
