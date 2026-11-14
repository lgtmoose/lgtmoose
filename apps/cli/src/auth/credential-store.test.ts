import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  type ListSecretsCommand,
  RestoreSecretCommand,
  TagResourceCommand,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import {
  awsCredentialStore,
  credentialDescription,
  credentialTags,
  rescheduleDays,
  type CredentialSender,
} from "./credential-store.js";

const LABEL = { providerId: "codex", harness: "codex", auth: "chatgpt-login" } as const;

function awsErr(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

function fake(responses: ((command: unknown) => unknown)[]) {
  const sent: unknown[] = [];
  const client: CredentialSender = {
    send: (command) => {
      sent.push(command);
      const next = responses.shift();
      try {
        return Promise.resolve((next?.(command) ?? {}) as never);
      } catch (error) {
        return Promise.reject(error as Error);
      }
    },
  };
  return { client, sent };
}

describe("awsCredentialStore", () => {
  it("creates the secret with its description and tags", async () => {
    const { client, sent } = fake([() => ({})]);
    expect(await awsCredentialStore(client, "eu-west-2").put(LABEL, "VALUE")).toEqual({
      outcome: "created",
    });
    const create = sent[0] as CreateSecretCommand;
    expect(create).toBeInstanceOf(CreateSecretCommand);
    expect(create.input).toMatchObject({
      Name: "lgtmoose/provider/codex",
      SecretString: "VALUE",
      Tags: [
        { Key: "app", Value: "lgtmoose" },
        { Key: "lgtmoose:kind", Value: "provider-credential" },
        { Key: "lgtmoose:provider", Value: "codex" },
        { Key: "lgtmoose:harness", Value: "codex" },
        { Key: "lgtmoose:auth", Value: "chatgpt-login" },
      ],
    });
    expect(create.input.Description).toContain('provider "codex"');
  });

  it("stores a new version of an existing secret and refreshes its tags", async () => {
    const { client, sent } = fake([
      () => {
        throw awsErr("ResourceExistsException");
      },
    ]);
    expect(await awsCredentialStore(client, "eu-west-2").put(LABEL, "VALUE")).toEqual({
      outcome: "updated",
    });
    expect((sent[1] as UpdateSecretCommand).input).toEqual({
      SecretId: "lgtmoose/provider/codex",
      SecretString: "VALUE",
      Description: credentialDescription(LABEL),
      ClientRequestToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect((sent[2] as TagResourceCommand).input).toEqual({
      SecretId: "lgtmoose/provider/codex",
      Tags: credentialTags(LABEL),
    });
  });

  const NOW = new Date("2026-11-14T00:00:00Z");
  const quick = { sleep: () => Promise.resolve(), now: () => NOW };
  const scheduled = () => {
    throw awsErr("InvalidRequestException", "already scheduled for deletion.");
  };
  const denied = () => {
    throw awsErr("AccessDeniedException", "not allowed to update");
  };
  const timeout = () => {
    throw awsErr("TimeoutError", "socket hang up");
  };
  const absent = () => ({ VersionIdsToStages: { "old-version": ["AWSCURRENT"] } });

  it("restores a secret scheduled for deletion before storing the new value", async () => {
    const { client, sent } = fake([scheduled]);
    expect(await awsCredentialStore(client, "eu-west-2", quick).put(LABEL, "VALUE")).toEqual({
      outcome: "restored",
    });
    expect(sent.map((c) => (c as object).constructor)).toEqual([
      CreateSecretCommand,
      DescribeSecretCommand,
      RestoreSecretCommand,
      UpdateSecretCommand,
      TagResourceCommand,
    ]);
  });

  it("reports a stored value whose tags couldn't be updated as stored, with the reason", async () => {
    const { client } = fake([
      () => {
        throw awsErr("ResourceExistsException");
      },
      () => ({}),
      () => {
        throw awsErr("AccessDeniedException", "not allowed to tag");
      },
    ]);
    expect(await awsCredentialStore(client, "eu-west-2", quick).put(LABEL, "VALUE")).toEqual({
      outcome: "updated",
      tagError: "not allowed to tag",
    });
  });

  it("puts the deletion back on its old date when AWS refused the new value", async () => {
    // DeletedDate in the future is the purge date: 10 days left.
    const purge = new Date("2026-11-24T00:00:00Z");
    const { client, sent } = fake([
      scheduled,
      () => ({ DeletedDate: purge }),
      () => ({}),
      denied,
      absent,
      absent,
      absent,
      () => ({}),
    ]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE-SECRET")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("not allowed to update");
    expect(String(error)).toContain("scheduled for deletion again, in 10 days, the same date");
    expect(String(error)).not.toContain("VALUE-SECRET");
    expect((sent[7] as DeleteSecretCommand).input).toEqual({
      SecretId: "lgtmoose/provider/codex",
      RecoveryWindowInDays: 10,
    });
  });

  it("clamps the old date to Secrets Manager's range, and says when it can't know it", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(rescheduleDays(new Date(NOW.getTime() + 2 * day), NOW)).toEqual({
      days: 7,
      note: ": 2 days were left, but Secrets Manager needs 7 to 30",
    });
    expect(rescheduleDays(new Date(NOW.getTime() + 40 * day), NOW).days).toBe(30);
    // A past DeletedDate is when the earlier remove ran: its window can't be known.
    expect(rescheduleDays(new Date(NOW.getTime() - day), NOW)).toEqual({
      days: 7,
      note: ": the earlier remove's window isn't known, so its date may have moved",
    });
    expect(rescheduleDays(undefined, NOW).days).toBe(7);
  });

  it("says the removal is cancelled and the OLD credential is live when rescheduling fails", async () => {
    const deleteFails = () => {
      throw awsErr("AccessDeniedException", "may not delete");
    };
    const { client } = fake([
      scheduled,
      () => ({}),
      () => ({}),
      denied,
      absent,
      absent,
      absent,
      deleteFails,
    ]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("(may not delete)");
    expect(String(error)).toContain("The earlier removal is cancelled");
    expect(String(error)).toContain("does hold the OLD credential");
    expect(String(error)).toContain("pnpm lgtmoose auth remove codex");
  });

  it("never undoes after an error AWS may have applied, even if the version looks absent", async () => {
    const { client, sent } = fake([
      scheduled,
      () => ({}),
      () => ({}),
      timeout,
      absent,
      absent,
      absent,
    ]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("Couldn't tell whether the new value was stored");
    expect(String(error)).toContain("The earlier removal is cancelled");
    expect(String(error)).toContain("may hold the OLD credential");
    expect(sent.some((c) => c instanceof DeleteSecretCommand)).toBe(false);
  });

  it("doesn't count a missing version list as a miss", async () => {
    const { client, sent } = fake([
      scheduled,
      () => ({}),
      () => ({}),
      denied,
      () => ({}),
      () => ({}),
      () => ({}),
    ]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("Couldn't tell");
    expect(sent.some((c) => c instanceof DeleteSecretCommand)).toBe(false);
  });

  it("keeps checking, and treats a failed update that landed late as stored", async () => {
    let token = "";
    const timesOut = (command: unknown) => {
      token = (command as UpdateSecretCommand).input.ClientRequestToken ?? "";
      throw awsErr("TimeoutError", "socket hang up");
    };
    const waits: number[] = [];
    const landed = () => ({ VersionIdsToStages: { [token]: ["AWSCURRENT"] } });
    const { client, sent } = fake([scheduled, () => ({}), () => ({}), timesOut, absent, landed]);
    const store = awsCredentialStore(client, "eu-west-2", {
      now: () => NOW,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(await store.put(LABEL, "VALUE")).toEqual({ outcome: "restored" });
    expect(waits).toEqual([300]);
    expect(sent.map((c) => (c as object).constructor).slice(3)).toEqual([
      UpdateSecretCommand,
      DescribeSecretCommand,
      DescribeSecretCommand,
      TagResourceCommand,
    ]);
  });

  it("says it can't tell when neither the update nor the checks answer", async () => {
    const { client, sent } = fake([
      () => {
        throw awsErr("ResourceExistsException");
      },
      timeout,
      timeout,
      timeout,
      timeout,
    ]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("It holds either the new value or the previous one");
    expect(sent).toHaveLength(5);
  });

  it("wraps other errors without the value", async () => {
    const { client } = fake([
      () => {
        throw awsErr("AccessDeniedException", "not allowed");
      },
    ]);
    const error = await awsCredentialStore(client, "eu-west-2")
      .put(LABEL, "VALUE-SECRET")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("lgtmoose/provider/codex: not allowed");
    expect(String(error)).not.toContain("VALUE-SECRET");
  });

  it("lists provider secrets across pages, by tag, keeping exact prefixes only", async () => {
    const { client, sent } = fake([
      () => ({
        SecretList: [
          {
            Name: "lgtmoose/provider/b",
            Tags: [
              { Key: "lgtmoose:provider", Value: "b" },
              { Key: "lgtmoose:auth", Value: "api-key" },
            ],
            LastChangedDate: new Date("2026-11-01"),
          },
          { Name: "other/lgtmoose/provider/x" },
        ],
        NextToken: "page-2",
      }),
      () => ({
        SecretList: [{ Name: "lgtmoose/provider/a", CreatedDate: new Date("2026-10-01") }],
      }),
    ]);
    const list = await awsCredentialStore(client, "eu-west-2").list();
    expect(list).toEqual([
      {
        name: "lgtmoose/provider/a",
        providerId: undefined,
        harness: undefined,
        auth: undefined,
        lastChanged: new Date("2026-10-01"),
      },
      {
        name: "lgtmoose/provider/b",
        providerId: "b",
        harness: undefined,
        auth: "api-key",
        lastChanged: new Date("2026-11-01"),
      },
    ]);
    const first = sent[0] as ListSecretsCommand;
    expect(first.input.Filters).toEqual([{ Key: "name", Values: ["lgtmoose/provider/"] }]);
    expect((sent[1] as ListSecretsCommand).input.NextToken).toBe("page-2");
  });

  it("schedules deletion with a recovery window, and says when there's nothing to remove", async () => {
    const date = new Date("2026-11-21T00:00:00Z");
    const { client, sent } = fake([
      () => ({ DeletionDate: date }),
      () => {
        throw awsErr("ResourceNotFoundException");
      },
    ]);
    const store = awsCredentialStore(client, "eu-west-2");
    expect(await store.remove("codex", 7)).toEqual({ status: "scheduled", deletionDate: date });
    expect((sent[0] as DeleteSecretCommand).input).toEqual({
      SecretId: "lgtmoose/provider/codex",
      RecoveryWindowInDays: 7,
    });
    expect(await store.remove("codex", 7)).toEqual({ status: "missing" });
  });

  it("says a secret was already scheduled, with the date an earlier remove set", async () => {
    const earlier = new Date("2026-11-15T00:00:00Z");
    const marked = () => {
      throw awsErr("InvalidRequestException", "it was marked for deletion");
    };
    const { client, sent } = fake([
      marked,
      () => ({ DeletedDate: earlier }),
      marked,
      () => {
        throw awsErr("AccessDeniedException");
      },
    ]);
    const store = awsCredentialStore(client, "eu-west-2");
    expect(await store.remove("codex", 7)).toEqual({
      status: "already-scheduled",
      scheduledSince: earlier,
    });
    expect(sent[1]).toBeInstanceOf(DescribeSecretCommand);
    // The date is a nicety: not being able to read it doesn't fail the remove.
    expect(await store.remove("codex", 7)).toEqual({ status: "already-scheduled" });
  });
});
