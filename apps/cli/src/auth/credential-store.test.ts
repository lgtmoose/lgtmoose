import {
  CreateSecretCommand,
  type DeleteSecretCommand,
  type ListSecretsCommand,
  PutSecretValueCommand,
  RestoreSecretCommand,
  TagResourceCommand,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it } from "vitest";
import { awsCredentialStore, credentialTags, type CredentialSender } from "./credential-store.js";

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
    expect(await awsCredentialStore(client, "eu-west-2").put(LABEL, "VALUE")).toBe("created");
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
    expect(await awsCredentialStore(client, "eu-west-2").put(LABEL, "VALUE")).toBe("updated");
    expect(sent[1]).toBeInstanceOf(PutSecretValueCommand);
    expect((sent[2] as TagResourceCommand).input).toEqual({
      SecretId: "lgtmoose/provider/codex",
      Tags: credentialTags(LABEL),
    });
  });

  it("restores a secret scheduled for deletion before storing the new value", async () => {
    const { client, sent } = fake([
      () => {
        throw awsErr(
          "InvalidRequestException",
          "You can't create this secret because a secret with this name is already scheduled for deletion.",
        );
      },
    ]);
    expect(await awsCredentialStore(client, "eu-west-2").put(LABEL, "VALUE")).toBe("restored");
    expect(sent.map((c) => (c as object).constructor)).toEqual([
      CreateSecretCommand,
      RestoreSecretCommand,
      PutSecretValueCommand,
      TagResourceCommand,
    ]);
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
    const { client, sent } = fake([
      () => ({}),
      () => {
        throw awsErr("ResourceNotFoundException");
      },
      () => {
        throw awsErr("InvalidRequestException", "it was marked for deletion");
      },
    ]);
    const store = awsCredentialStore(client, "eu-west-2");
    expect(await store.remove("codex", 7)).toBe("scheduled");
    expect((sent[0] as DeleteSecretCommand).input).toEqual({
      SecretId: "lgtmoose/provider/codex",
      RecoveryWindowInDays: 7,
    });
    expect(await store.remove("codex", 7)).toBe("missing");
    expect(await store.remove("codex", 7)).toBe("scheduled");
  });
});
