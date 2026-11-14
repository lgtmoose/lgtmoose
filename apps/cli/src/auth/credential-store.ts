import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  ListSecretsCommand,
  RestoreSecretCommand,
  SecretsManagerClient,
  TagResourceCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  PROVIDER_CREDENTIAL_KIND,
  PROVIDER_CREDENTIAL_TAGS,
  PROVIDER_SECRET_PREFIX,
  SECRET_NAMES,
  type AuthMethod,
  type Harness,
} from "@lgtmoose/config";
import { awsError, errorName, isScheduledForDeletion } from "../aws-errors.js";

/** What a provider credential is for. Stored as tags, never with the value. */
export interface CredentialLabel {
  providerId: string;
  harness: Harness;
  auth: AuthMethod;
}

/** A stored provider credential as Secrets Manager lists it: metadata only, never the value. */
export interface StoredCredential {
  name: string;
  /** From the tags; undefined when a tag is missing, such as on a secret made by hand. */
  providerId: string | undefined;
  harness: string | undefined;
  auth: string | undefined;
  lastChanged: Date | undefined;
}

export interface PutResult {
  outcome: "created" | "updated" | "restored";
  /**
   * Set when the value was stored but the tags couldn't be rewritten, so they may still
   * describe an earlier harness or auth. Running auth again fixes them.
   */
  tagError?: string;
}

export interface RemoveResult {
  /** "already-scheduled": an earlier remove scheduled it, and its date still applies. */
  status: "scheduled" | "already-scheduled" | "missing";
  /** When Secrets Manager will delete it, when it says. */
  deletionDate?: Date;
}

/** The Secrets Manager calls `lgtmoose auth` makes. Tests swap in an in-memory version. */
export interface CredentialStore {
  /**
   * Stores the credential under `SECRET_NAMES.provider(id)` with its tags. Creates the secret,
   * stores a new version of an existing one, or first restores one that `auth remove`
   * scheduled for deletion.
   */
  put(label: CredentialLabel, value: string): Promise<PutResult>;
  /** Every provider credential, by name prefix. Secrets scheduled for deletion are left out. */
  list(): Promise<StoredCredential[]>;
  /** Schedules the provider's credential for deletion. */
  remove(providerId: string, recoveryDays: number): Promise<RemoveResult>;
}

export function credentialTags(label: CredentialLabel): { Key: string; Value: string }[] {
  return [
    { Key: PROVIDER_CREDENTIAL_TAGS.app, Value: "lgtmoose" },
    { Key: PROVIDER_CREDENTIAL_TAGS.kind, Value: PROVIDER_CREDENTIAL_KIND },
    { Key: PROVIDER_CREDENTIAL_TAGS.provider, Value: label.providerId },
    { Key: PROVIDER_CREDENTIAL_TAGS.harness, Value: label.harness },
    { Key: PROVIDER_CREDENTIAL_TAGS.auth, Value: label.auth },
  ];
}

export function credentialDescription(label: CredentialLabel): string {
  return (
    `${label.auth} credential for LGTMoose provider "${label.providerId}" (${label.harness}). ` +
    "Written by lgtmoose auth; read by the sandbox task that runs it."
  );
}

type Command =
  | CreateSecretCommand
  | DeleteSecretCommand
  | DescribeSecretCommand
  | ListSecretsCommand
  | UpdateSecretCommand
  | RestoreSecretCommand
  | TagResourceCommand;

interface SecretListEntry {
  Name?: string | undefined;
  Tags?: { Key?: string | undefined; Value?: string | undefined }[] | undefined;
  LastChangedDate?: Date | undefined;
  CreatedDate?: Date | undefined;
}

/** The subset of SecretsManagerClient we use, so tests can fake `send`. */
export interface CredentialSender {
  send(command: Command): Promise<{
    SecretList?: SecretListEntry[] | undefined;
    NextToken?: string | undefined;
    /** DeleteSecret's answer. */
    DeletionDate?: Date | undefined;
    /** DescribeSecret's answer, for a secret scheduled for deletion. */
    DeletedDate?: Date | undefined;
  }>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function awsCredentialStore(client: CredentialSender, region: string): CredentialStore {
  const context = (name: string, error: unknown) =>
    awsError("Secrets Manager", region, name, error);

  return {
    async put(label, value) {
      const name = SECRET_NAMES.provider(label.providerId);
      let outcome: PutResult["outcome"];
      try {
        await client.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: value,
            Description: credentialDescription(label),
            Tags: credentialTags(label),
          }),
        );
        return { outcome: "created" };
      } catch (error) {
        const scheduled = isScheduledForDeletion(error);
        if (errorName(error) !== "ResourceExistsException" && !scheduled) {
          throw context(name, error);
        }
        outcome = scheduled ? "restored" : "updated";
      }
      try {
        if (outcome === "restored") {
          await client.send(new RestoreSecretCommand({ SecretId: name }));
        }
        // A new version of the value. The provider's harness or auth may have changed since
        // the secret was created, so the description and tags are rewritten too.
        await client.send(
          new UpdateSecretCommand({
            SecretId: name,
            SecretString: value,
            Description: credentialDescription(label),
          }),
        );
      } catch (error) {
        throw context(name, error);
      }
      try {
        await client.send(new TagResourceCommand({ SecretId: name, Tags: credentialTags(label) }));
      } catch (error) {
        // The value is stored, so this isn't a failure to store it.
        return { outcome, tagError: message(error) };
      }
      return { outcome };
    },

    async list() {
      const found: StoredCredential[] = [];
      let nextToken: string | undefined;
      do {
        let page;
        try {
          page = await client.send(
            new ListSecretsCommand({
              Filters: [{ Key: "name", Values: [PROVIDER_SECRET_PREFIX] }],
              IncludePlannedDeletion: false,
              NextToken: nextToken,
            }),
          );
        } catch (error) {
          throw context(`${PROVIDER_SECRET_PREFIX}*`, error);
        }
        for (const entry of page.SecretList ?? []) {
          // The name filter matches a prefix of any word in the name; keep exact prefixes only.
          if (entry.Name === undefined || !entry.Name.startsWith(PROVIDER_SECRET_PREFIX)) continue;
          const tag = (key: string) => entry.Tags?.find((t) => t.Key === key)?.Value;
          found.push({
            name: entry.Name,
            providerId: tag(PROVIDER_CREDENTIAL_TAGS.provider),
            harness: tag(PROVIDER_CREDENTIAL_TAGS.harness),
            auth: tag(PROVIDER_CREDENTIAL_TAGS.auth),
            lastChanged: entry.LastChangedDate ?? entry.CreatedDate,
          });
        }
        nextToken = page.NextToken;
      } while (nextToken !== undefined);
      return found.sort((a, b) => a.name.localeCompare(b.name));
    },

    async remove(providerId, recoveryDays) {
      const name = SECRET_NAMES.provider(providerId);
      try {
        const { DeletionDate } = await client.send(
          new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: recoveryDays }),
        );
        return { status: "scheduled", ...(DeletionDate ? { deletionDate: DeletionDate } : {}) };
      } catch (error) {
        if (errorName(error) === "ResourceNotFoundException") return { status: "missing" };
        if (!isScheduledForDeletion(error)) throw context(name, error);
      }
      // Removed before: the earlier date applies. The date is a nicety, so a failure to read
      // it doesn't fail the command.
      try {
        const { DeletedDate } = await client.send(new DescribeSecretCommand({ SecretId: name }));
        return {
          status: "already-scheduled",
          ...(DeletedDate ? { deletionDate: DeletedDate } : {}),
        };
      } catch {
        return { status: "already-scheduled" };
      }
    },
  };
}

export function createCredentialStore(region: string): CredentialStore {
  return awsCredentialStore(new SecretsManagerClient({ region }), region);
}
