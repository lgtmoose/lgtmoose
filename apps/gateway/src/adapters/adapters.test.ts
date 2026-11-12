import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { ReviewJob } from "@lgtmoose/core";
import { describe, expect, it, vi } from "vitest";
import { parseAllowedOrgs, requiredEnv } from "../env.js";
import {
  SECRET_MIN_REFRESH_MS,
  SECRET_TTL_MS,
  fifoId,
  secretsManagerWebhookSecret,
  sqsJobQueue,
} from "./aws.js";
import { envWebhookSecret, logJobQueue } from "./local.js";

const job: ReviewJob = {
  kind: "pr_opened",
  deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
  installationId: 1,
  repo: "acme-corp/widgets",
  prNumber: 42,
  actor: "octo-dev",
  receivedAt: "2026-11-12T10:00:00.000Z",
};

/** A fake Secrets Manager whose value can change, and a clock the test moves. */
function fakeSecretsManager(initial = "s1") {
  let value: string | undefined = initial;
  let clock = 1_000_000;
  const send = vi.fn(async (command: GetSecretValueCommand) => ({
    $metadata: {},
    Name: command.input.SecretId,
    SecretString: value,
  }));
  const store = secretsManagerWebhookSecret({
    client: { send },
    secretId: "arn:secret",
    now: () => clock,
  });
  return {
    store,
    send,
    set: (next: string | undefined) => void (value = next),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("secretsManagerWebhookSecret", () => {
  it("fetches the named secret and caches it for about five minutes", async () => {
    const sm = fakeSecretsManager();
    expect(await sm.store.get()).toBe("s1");
    expect(sm.send.mock.calls[0]?.[0].input).toEqual({ SecretId: "arn:secret" });
    sm.set("s2");
    sm.advance(SECRET_TTL_MS - 1);
    expect(await sm.store.get()).toBe("s1");
    sm.advance(1);
    expect(await sm.store.get()).toBe("s2");
    expect(sm.send).toHaveBeenCalledTimes(2);
    expect(SECRET_TTL_MS).toBe(300_000);
  });

  it("refetches on request, but no more than once per interval", async () => {
    const sm = fakeSecretsManager();
    await sm.store.get();
    sm.set("rotated");
    // Just fetched: a refresh now is a forged signature, not a rotation, so serve the cache.
    expect(await sm.store.get({ refresh: true })).toBe("s1");
    sm.advance(SECRET_MIN_REFRESH_MS);
    expect(await sm.store.get({ refresh: true })).toBe("rotated");
    expect(await sm.store.get({ refresh: true })).toBe("rotated");
    expect(sm.send).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch between concurrent cold-start requests", async () => {
    const sm = fakeSecretsManager();
    const values = await Promise.all([sm.store.get(), sm.store.get(), sm.store.get()]);
    expect(values).toEqual(["s1", "s1", "s1"]);
    expect(sm.send).toHaveBeenCalledOnce();
  });

  it("doesn't cache failures or empty values", async () => {
    const sm = fakeSecretsManager();
    sm.set(undefined);
    await expect(sm.store.get()).rejects.toThrow("secret arn:secret has no string value");
    sm.send.mockRejectedValueOnce(new Error("throttled"));
    await expect(sm.store.get()).rejects.toThrow("throttled");
    sm.set("s3");
    expect(await sm.store.get()).toBe("s3");
    expect(sm.send).toHaveBeenCalledTimes(3);
  });
});

describe("sqsJobQueue", () => {
  it("sends the job as JSON with the group and deduplication IDs", async () => {
    const send = vi.fn(async (_command: SendMessageCommand) => ({}));
    const queue = sqsJobQueue({ client: { send }, queueUrl: "https://sqs.example/jobs.fifo" });
    await queue.send(job, { groupId: "acme-corp/widgets#42", dedupeId: job.deliveryId });
    expect(send.mock.calls[0]?.[0].input).toEqual({
      QueueUrl: "https://sqs.example/jobs.fifo",
      MessageBody: JSON.stringify(job),
      MessageGroupId: "acme-corp/widgets#42",
      MessageDeduplicationId: job.deliveryId,
    });
  });

  it("passes SQS errors up, so the gateway answers 500", async () => {
    const send = vi.fn(async () => {
      throw new Error("AccessDenied");
    });
    const queue = sqsJobQueue({ client: { send }, queueUrl: "q" });
    await expect(queue.send(job, { groupId: "g", dedupeId: "d" })).rejects.toThrow("AccessDenied");
  });
});

describe("fifoId", () => {
  it("keeps IDs SQS accepts as they are", () => {
    for (const id of ["acme-corp/widgets#42", "72d3162e-cc78-11e3-81ab-4c9367dc0958", "a.b_c"]) {
      expect(fifoId(id)).toBe(id);
    }
  });

  it("hashes IDs that are too long or use other characters, deterministically", () => {
    const long = `${"o".repeat(39)}/${"r".repeat(100)}#123456`;
    const hashed = fifoId(long);
    expect(hashed).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(fifoId(long)).toBe(hashed);
    expect(fifoId("acme/ünïcode#1")).toMatch(/^sha256-/);
  });
});

describe("local adapters", () => {
  it("reads the webhook secret from the environment on every call", async () => {
    const env: NodeJS.ProcessEnv = { GITHUB_WEBHOOK_SECRET: "one" };
    const store = envWebhookSecret("GITHUB_WEBHOOK_SECRET", env);
    expect(await store.get()).toBe("one");
    env.GITHUB_WEBHOOK_SECRET = "two";
    expect(await store.get({ refresh: true })).toBe("two");
    env.GITHUB_WEBHOOK_SECRET = "";
    await expect(store.get()).rejects.toThrow("GITHUB_WEBHOOK_SECRET is not set");
  });

  it("logs jobs instead of queueing them", async () => {
    const lines: string[] = [];
    await logJobQueue((line) => lines.push(line)).send(job, { groupId: "g", dedupeId: "d" });
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ groupId: "g", dedupeId: "d", job });
  });
});

describe("env", () => {
  it("splits ALLOWED_ORGS on commas and needs at least one", () => {
    expect(parseAllowedOrgs("acme-corp, Other ,,")).toEqual(["acme-corp", "Other"]);
    for (const raw of [undefined, "", " , "]) {
      expect(() => parseAllowedOrgs(raw)).toThrow("ALLOWED_ORGS");
    }
  });

  it("requires set, non-empty values", () => {
    expect(requiredEnv("A", { A: "x" })).toBe("x");
    expect(() => requiredEnv("A", { A: "" })).toThrow("A must be set");
    expect(() => requiredEnv("A", {})).toThrow("A must be set");
  });
});
