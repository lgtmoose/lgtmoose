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

  const quick = { sleep: () => Promise.resolve() };
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

  it("undoes a refused restore at once, with lgtmoose's window and AWS's date", async () => {
    const { client, sent } = fake([
      scheduled,
      () => ({}),
      denied,
      () => ({ DeletionDate: new Date("2026-11-21T00:00:00Z") }),
    ]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE-SECRET")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("not allowed to update");
    expect(String(error)).toContain(
      "Scheduled for deletion on 2026-11-21T00:00:00.000Z. The earlier removal's date isn't kept.",
    );
    expect(String(error)).not.toContain("VALUE-SECRET");
    // A refusal can't have landed, so there's nothing to check first.
    expect(sent.some((c) => c instanceof DescribeSecretCommand)).toBe(false);
    expect((sent[3] as DeleteSecretCommand).input).toEqual({
      SecretId: "lgtmoose/provider/codex",
      RecoveryWindowInDays: 7,
    });
  });

  it("says the removal is cancelled and the OLD credential is live when rescheduling fails", async () => {
    const deleteFails = () => {
      throw awsErr("AccessDeniedException", "may not delete");
    };
    const { client } = fake([scheduled, () => ({}), denied, deleteFails]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE", { rerun: "pnpm lgtmoose auth codex --id codex" })
      .catch((e: unknown) => e);
    expect(String(error)).toContain("(may not delete)");
    expect(String(error)).toContain("The earlier removal is cancelled");
    expect(String(error)).toContain("does hold the OLD credential");
    // The exact command, not a bare `auth` that only prints help.
    expect(String(error)).toContain("Run pnpm lgtmoose auth codex --id codex again");
    expect(String(error)).toContain("pnpm lgtmoose auth remove codex");
  });

  it("never undoes after an error AWS may have applied, even if every check looks absent", async () => {
    const { client, sent } = fake([scheduled, () => ({}), timeout, absent, absent, absent]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("Couldn't tell whether the new value was stored");
    expect(String(error)).toContain("The earlier removal is cancelled");
    expect(String(error)).toContain("may hold the OLD credential");
    expect(sent.filter((c) => c instanceof DescribeSecretCommand)).toHaveLength(3);
    expect(sent.some((c) => c instanceof DeleteSecretCommand)).toBe(false);
  });

  it("waits out a lagging answer: absent at first, then current, is stored", async () => {
    let token = "";
    const timesOut = (command: unknown) => {
      token = (command as UpdateSecretCommand).input.ClientRequestToken ?? "";
      throw awsErr("TimeoutError", "socket hang up");
    };
    const waits: number[] = [];
    const landed = () => ({ VersionIdsToStages: { [token]: ["AWSCURRENT"] } });
    const { client, sent } = fake([scheduled, () => ({}), timesOut, absent, () => ({}), landed]);
    const store = awsCredentialStore(client, "eu-west-2", {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(await store.put(LABEL, "VALUE")).toEqual({ outcome: "restored" });
    expect(waits).toEqual([300, 1000]);
    expect(sent.at(-1)).toBeInstanceOf(TagResourceCommand);
  });

  it("an existing secret's refused update fails without checking or undoing", async () => {
    const { client, sent } = fake([
      () => {
        throw awsErr("ResourceExistsException");
      },
      denied,
    ]);
    const error = await awsCredentialStore(client, "eu-west-2", quick)
      .put(LABEL, "VALUE")
      .catch((e: unknown) => e);
    expect(String(error)).toContain("not allowed to update");
    expect(sent).toHaveLength(2);
  });

  it("says it can't tell when neither the update nor the checks answer, naming the command", async () => {
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
      .put(LABEL, "VALUE", { rerun: "pnpm lgtmoose auth codex" })
      .catch((e: unknown) => e);
    expect(String(error)).toContain(
      "It holds either the new value or the previous one. Run pnpm lgtmoose auth codex again",
    );
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
