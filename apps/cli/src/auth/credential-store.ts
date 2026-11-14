import { randomUUID } from "node:crypto";
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
import {
  awsError,
  awsMessage,
  awsReason,
  errorName,
  isScheduledForDeletion,
} from "../aws-errors.js";

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

export type RemoveResult =
  /** This remove scheduled it. `deletionDate` is when Secrets Manager deletes it, as it says. */
  | { status: "scheduled"; deletionDate?: Date }
  /**
   * An earlier remove scheduled it, with a window this can't learn. `scheduledSince` is when
   * that remove ran (DescribeSecret's DeletedDate), not when the secret goes.
   */
  | { status: "already-scheduled"; scheduledSince?: Date }
  | { status: "missing" };

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
    /** DescribeSecret's answer: each version id and its stages, such as AWSCURRENT. */
    VersionIdsToStages?: Record<string, string[]> | undefined;
  }>;
}

/** How long a removed credential can be restored. `auth remove` uses it too. */
export const RECOVERY_DAYS = 7;

export function awsCredentialStore(client: CredentialSender, region: string): CredentialStore {
  const context = (name: string, error: unknown) =>
    awsError("Secrets Manager", region, name, error);

  /**
   * After UpdateSecret failed: did the version it asked for become current anyway? A timeout
   * or a dropped connection can fail a call AWS still applied. Undefined when it can't tell.
   */
  async function versionLanded(name: string, token: string): Promise<boolean | undefined> {
    try {
      const { VersionIdsToStages } = await client.send(
        new DescribeSecretCommand({ SecretId: name }),
      );
      return VersionIdsToStages?.[token]?.includes("AWSCURRENT") ?? false;
    } catch {
      return undefined;
    }
  }

  /**
   * The restore worked but the new value definitely didn't, so the OLD credential is live
   * again. Schedules the deletion again. The earlier remove's window isn't known, so it
   * uses the default one and says so, and gives the reason if even that fails.
   */
  async function undoRestore(name: string, error: unknown): Promise<Error> {
    const reason = awsMessage(error);
    try {
      await client.send(
        new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: RECOVERY_DAYS }),
      );
    } catch (deleteError) {
      return new Error(
        `Restored ${name} (${region}) but couldn't store the new value: ${reason} Scheduling ` +
          `its deletion again failed too (${awsReason(deleteError)}). It holds the OLD ` +
          "credential again, and sandbox tasks will use it. Run this again, or remove it.",
        { cause: error },
      );
    }
    return new Error(
      `Couldn't store the new value in ${name} (${region}): ${reason} It was restored first, ` +
        `so it's scheduled for deletion again, in ${RECOVERY_DAYS} days: the earlier remove's ` +
        "window isn't known, so its date may have moved.",
      { cause: error },
    );
  }

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
      if (outcome === "restored") {
        try {
          await client.send(new RestoreSecretCommand({ SecretId: name }));
        } catch (error) {
          throw context(name, error);
        }
      }
      // Our own version id, so a failed call can be checked for whether it landed anyway.
      const token = randomUUID();
      try {
        // A new version of the value. The provider's harness or auth may have changed since
        // the secret was created, so the description and tags are rewritten too.
        await client.send(
          new UpdateSecretCommand({
            SecretId: name,
            SecretString: value,
            Description: credentialDescription(label),
            ClientRequestToken: token,
          }),
        );
      } catch (error) {
        const landed = await versionLanded(name, token);
        if (landed === false) {
          throw outcome === "restored" ? await undoRestore(name, error) : context(name, error);
        }
        if (landed === undefined) {
          const holds =
            outcome === "restored"
              ? "It was restored first, so it holds either the new value or the OLD one."
              : "It holds either the new value or the previous one.";
          throw new Error(
            `Couldn't tell whether the new value was stored in ${name} (${region}): ` +
              `${awsMessage(error)} ${holds} Run this again to be sure.`,
            { cause: error },
          );
        }
        // It landed: the failure was only in hearing back.
      }
      try {
        await client.send(new TagResourceCommand({ SecretId: name, Tags: credentialTags(label) }));
      } catch (error) {
        // The value is stored, so this isn't a failure to store it.
        return { outcome, tagError: awsReason(error) };
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
      // Removed before, and that schedule stands. DeletedDate is when that remove ran; the
      // window it used isn't returned. It's a nicety, so failing to read it doesn't fail this.
      try {
        const { DeletedDate } = await client.send(new DescribeSecretCommand({ SecretId: name }));
        return {
          status: "already-scheduled",
          ...(DeletedDate ? { scheduledSince: DeletedDate } : {}),
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
