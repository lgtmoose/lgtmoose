import { randomUUID } from "node:crypto";
import { CLI } from "../paths.js";
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
  put(
    label: CredentialLabel,
    value: string,
    /** The command that stored it, for messages that tell the person to run it again. */
    options?: { rerun?: string },
  ): Promise<PutResult>;
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

/** Waits before each DescribeSecret that checks whether a failed update landed. */
const LANDED_CHECK_WAITS_MS = [0, 300, 1000];

/**
 * Errors where AWS refused the request outright, so it can't have been applied. Anything
 * else (timeouts, throttling, server errors, dropped connections) might have been.
 */
const DEFINITE_CLIENT_ERRORS = new Set([
  "AccessDeniedException",
  "InvalidParameterException",
  "InvalidRequestException",
  "ValidationException",
  "LimitExceededException",
  "ResourceNotFoundException",
  "MalformedPolicyDocumentException",
  "EncryptionFailure",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Said whenever a restore stands with the old value in it. */
function oldValueLive(
  providerId: string,
  rerun: string | undefined,
  certainty: "does" | "may" = "does",
): string {
  const again = rerun ?? `the same ${CLI} auth command`;
  return (
    `The earlier removal is cancelled: the secret is restored and ${certainty} hold the OLD ` +
    `credential, which sandbox tasks will use. Run ${again} again, or ` +
    `${CLI} auth remove ${providerId}.`
  );
}

export interface CredentialStoreOptions {
  /** Waits between checks. Tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function awsCredentialStore(
  client: CredentialSender,
  region: string,
  options: CredentialStoreOptions = {},
): CredentialStore {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const context = (name: string, error: unknown) =>
    awsError("Secrets Manager", region, name, error);

  /**
   * After UpdateSecret failed: did the version it asked for become current anyway? A timeout
   * or a dropped connection can fail a call AWS still applied, and DescribeSecret can lag. So
   * seeing the version stops at once, but not seeing it counts only once the last check also
   * says so, unless AWS refused the update outright (`refused`), when one answer is enough.
   * True when it's current; false when the deciding answer listed the versions without it;
   * undefined when that answer never came.
   */
  async function versionLanded(
    name: string,
    token: string,
    refused: boolean,
  ): Promise<boolean | undefined> {
    let last: boolean | undefined;
    for (const [attempt, wait] of LANDED_CHECK_WAITS_MS.entries()) {
      if (attempt > 0) await sleep(wait);
      try {
        const { VersionIdsToStages } = await client.send(
          new DescribeSecretCommand({ SecretId: name }),
        );
        if (VersionIdsToStages === undefined) {
          last = undefined;
          continue;
        }
        if (VersionIdsToStages[token]?.includes("AWSCURRENT")) return true;
        if (refused) return false;
        last = false;
      } catch {
        last = undefined;
      }
    }
    return last;
  }

  /** When the secret was set to be deleted, read before restoring it. Undefined if unknown. */
  async function deletedDate(name: string): Promise<Date | undefined> {
    try {
      return (await client.send(new DescribeSecretCommand({ SecretId: name }))).DeletedDate;
    } catch {
      return undefined;
    }
  }

  /**
   * The restore worked but the new value definitely didn't, so the OLD credential is live
   * again. Schedules the deletion again with lgtmoose's window, and reports the date AWS gives.
   * The earlier date isn't kept: AWS doesn't say which window the earlier removal chose. When
   * it was removed more than RECOVERY_DAYS ago and still wasn't deleted, its window was
   * longer (it wasn't `auth remove`), and this says it has been shortened.
   */
  async function undoRestore(
    name: string,
    providerId: string,
    rerun: string | undefined,
    error: unknown,
    deletedAt: Date | undefined,
  ): Promise<Error> {
    const reason = awsMessage(error);
    let deletionDate: Date | undefined;
    try {
      ({ DeletionDate: deletionDate } = await client.send(
        new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: RECOVERY_DAYS }),
      ));
    } catch (deleteError) {
      return new Error(
        `Restored ${name} (${region}) but couldn't store the new value: ${reason} Scheduling ` +
          `its deletion again failed too (${awsReason(deleteError)}). ` +
          oldValueLive(providerId, rerun),
        { cause: error },
      );
    }
    const when =
      deletionDate === undefined ? `in ${RECOVERY_DAYS} days` : `on ${deletionDate.toISOString()}`;
    const shortened =
      deletedAt !== undefined && now().getTime() - deletedAt.getTime() > RECOVERY_DAYS * DAY_MS
        ? ` It had been scheduled since ${deletedAt.toISOString()}, so it was removed with a ` +
          `window longer than ${RECOVERY_DAYS} days, which this shortens.`
        : "";
    return new Error(
      `Couldn't store the new value in ${name} (${region}): ${reason} It was restored first, ` +
        `so it's scheduled for deletion again, ${when}; the earlier removal's date isn't ` +
        `kept.${shortened}`,
      { cause: error },
    );
  }

  return {
    async put(label, value, putOptions = {}) {
      const { rerun } = putOptions;
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
      let scheduledDate: Date | undefined;
      if (outcome === "restored") {
        // Read first, so an undo can tell whether it shortens the earlier window.
        scheduledDate = await deletedDate(name);
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
        const refused = DEFINITE_CLIENT_ERRORS.has(errorName(error) ?? "");
        const landed = await versionLanded(name, token, refused);
        // Undo only when AWS refused outright and the version is confirmed absent; a timeout
        // or a lagging answer could mean the new value is in, and undoing would delete it.
        if (landed === false && refused) {
          throw outcome === "restored"
            ? await undoRestore(name, label.providerId, rerun, error, scheduledDate)
            : context(name, error);
        }
        if (landed !== true) {
          const holds =
            outcome === "restored"
              ? oldValueLive(label.providerId, rerun, "may")
              : `It holds either the new value or the previous one. Run ${rerun ?? `the same ${CLI} auth command`} again to be sure.`;
          throw new Error(
            `Couldn't tell whether the new value was stored in ${name} (${region}): ` +
              `${awsMessage(error)} ${holds}`,
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
