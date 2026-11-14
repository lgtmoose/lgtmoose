import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SFNClient } from "@aws-sdk/client-sfn";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  credentialsFromEnv,
  executionRunning,
  reportProblem,
  secretsManagerCredentials,
} from "./credentials-aws.js";

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function client<T>(reply: (command: { constructor: { name: string }; input: unknown }) => unknown) {
  return { send: vi.fn(async (command) => reply(command)) } as unknown as T & {
    send: ReturnType<typeof vi.fn>;
  };
}

describe("secretsManagerCredentials", () => {
  it("describes the current version and when it was stored, without reading the value", async () => {
    const since = new Date("2026-01-01T00:00:00Z");
    const c = client<SecretsManagerClient>((command) => {
      if (command.constructor.name === "DescribeSecretCommand") {
        return { VersionIdsToStages: { old: ["AWSPREVIOUS"], cur: ["AWSCURRENT"] } };
      }
      if (command.constructor.name === "ListSecretVersionIdsCommand") {
        return { Versions: [{ VersionId: "old" }, { VersionId: "cur", CreatedDate: since }] };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    expect(await secretsManagerCredentials(c).describe("s")).toEqual({
      exists: true,
      deleting: false,
      currentVersion: "cur",
      currentSince: since,
    });
  });

  it("tells a missing secret and one scheduled for deletion", async () => {
    const missing = client<SecretsManagerClient>(() => {
      throw named("ResourceNotFoundException");
    });
    expect(await secretsManagerCredentials(missing).describe("s")).toMatchObject({
      exists: false,
      currentVersion: undefined,
    });
    const deleting = client<SecretsManagerClient>((command) =>
      command.constructor.name === "DescribeSecretCommand"
        ? { DeletedDate: new Date(), VersionIdsToStages: { v: ["AWSCURRENT"] } }
        : { Versions: [] },
    );
    expect(await secretsManagerCredentials(deleting).describe("s")).toMatchObject({
      exists: true,
      deleting: true,
    });
  });

  it("writes with the request token, so a retried write is the same version", async () => {
    const c = client<SecretsManagerClient>(() => ({ VersionId: "v2" }));
    expect(await secretsManagerCredentials(c).write("s", "value", "token-1")).toBe("v2");
    expect(c.send.mock.calls[0]?.[0].input).toEqual({
      SecretId: "s",
      SecretString: "value",
      ClientRequestToken: "token-1",
    });
  });
});

describe("executionRunning", () => {
  it("is true only for a running execution", async () => {
    const c = client<SFNClient>((command) => {
      const arn = (command.input as { executionArn: string }).executionArn;
      if (arn === "gone") throw named("ExecutionDoesNotExist");
      return { status: arn === "busy" ? "RUNNING" : "ABORTED" };
    });
    const running = executionRunning(c);
    expect(await running("busy")).toBe(true);
    expect(await running("stopped")).toBe(false);
    expect(await running("gone")).toBe(false);
  });
});

describe("reportProblem", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes an embedded metric per provider", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    reportProblem("codex", 1, "a review run was refused for auth");
    const line = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      Provider: "codex",
      CredentialProblem: 1,
      reason: "a review run was refused for auth",
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: "LGTMoose",
            Dimensions: [["Provider"]],
            Metrics: [{ Name: "CredentialProblem", Unit: "Count" }],
          },
        ],
      },
    });
  });
});

describe("credentialsFromEnv", () => {
  it("reads the stack's credentials and refuses a bad one", () => {
    const value = JSON.stringify({ codex: { secretId: "arn", auth: "chatgpt-login", limit: 1 } });
    expect(credentialsFromEnv({ LGTMOOSE_CREDENTIALS: value }).codex?.limit).toBe(1);
    expect(() => credentialsFromEnv({})).toThrow("LGTMOOSE_CREDENTIALS");
    expect(() =>
      credentialsFromEnv({ LGTMOOSE_CREDENTIALS: JSON.stringify({ codex: { limit: 0 } }) }),
    ).toThrow();
  });
});
