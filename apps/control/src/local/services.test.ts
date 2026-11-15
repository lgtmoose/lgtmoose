import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { egressAllowlist, parseDeployConfig } from "@lgtmoose/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileCredentialSecrets, readSecretFile, secretFile } from "./secrets.js";
import { consumeConversations, queueSender, sweep } from "./services.js";
import { checkEgressHosts, localSettings } from "./settings.js";

describe("the runner's services", () => {
  it("sends jobs in their PR's group, deduplicated by delivery", async () => {
    const sent: unknown[] = [];
    const sender = queueSender({
      send: async (message) => {
        sent.push(message);
        return true;
      },
    });
    const job = {
      kind: "pr_opened" as const,
      deliveryId: "d1",
      installationId: 1,
      repo: "acme/shop",
      prNumber: 7,
      actor: "dev",
      receivedAt: "2026-11-15T00:00:00.000Z",
    };
    await sender.send(job);
    await sender.sendWith(job, { groupId: "g", dedupeId: "x" });
    expect(sent).toEqual([
      { groupId: "acme/shop#7", dedupeId: "d1", body: JSON.stringify(job) },
      { groupId: "g", dedupeId: "x", body: JSON.stringify(job) },
    ]);
  });

  it("acks handled conversation jobs and retries failed ones", async () => {
    const acked: number[] = [];
    const retried: number[] = [];
    const queue = {
      send: async () => true,
      receive: async () => [
        { id: 1, groupId: "a#1", body: "{}", receiveCount: 1 },
        { id: 2, groupId: "a#2", body: "{}", receiveCount: 1 },
      ],
      ack: async (id: number) => {
        acked.push(id);
      },
      retryLater: async (id: number) => {
        retried.push(id);
      },
      prune: async () => 0,
    };
    const handled = await consumeConversations(queue, async (records) => {
      expect(records.map((record) => record.attributes?.MessageGroupId)).toEqual(["a#1", "a#2"]);
      return { batchItemFailures: [{ itemIdentifier: "2" }] };
    });
    expect(handled).toBe(2);
    expect(acked).toEqual([1]);
    expect(retried).toEqual([2]);
  });

  it("sweeps artifacts and ended executions after 30 days, and prunes the queues", async () => {
    const calls: string[] = [];
    const now = new Date("2026-11-15T00:00:00.000Z");
    const result = await sweep({
      now: () => now,
      artifacts: {
        deleteOlder: async (prefix, before) => {
          calls.push(`artifacts ${prefix}|${before.toISOString()}`);
          return 3;
        },
      },
      executions: {
        pruneEnded: async (before) => {
          calls.push(`executions ${before.toISOString()}`);
          return 2;
        },
      },
      queues: [{ prune: async () => 1 }, { prune: async () => 4 }],
    });
    expect(result).toEqual({ artifacts: 3, executions: 2, messages: 5 });
    expect(calls).toEqual([
      "artifacts |2026-10-16T00:00:00.000Z",
      "executions 2026-10-16T00:00:00.000Z",
    ]);
  });
});

describe("the runner's settings", () => {
  const base = {
    region: "us-east-1",
    allowedOrgs: ["acme"],
    providers: [
      { id: "claude", harness: "claude-code", auth: "oauth-token" },
      { id: "chatgpt", harness: "codex", auth: "chatgpt-login" },
    ],
  };

  it("orders providers reviewer first, with their credentials and limits", () => {
    const settings = localSettings(parseDeployConfig({ ...base, roles: { reviewer: "chatgpt" } }));
    expect(settings.providers.map((provider) => [provider.id, provider.credential])).toEqual([
      ["chatgpt", { secretId: "lgtmoose/provider/chatgpt", limit: 1 }],
      ["claude", { secretId: "lgtmoose/provider/claude", limit: 2 }],
    ]);
    expect(settings.embeddings).toEqual({ provider: "none" });
    expect(settings.tickets).toEqual({ provider: "none" });
  });

  it("checks the proxy's allowlist against the config", () => {
    const config = parseDeployConfig(base);
    const want = egressAllowlist(config);
    expect(() => checkEgressHosts(config, ` ${want.join(" , ").toUpperCase()} `)).not.toThrow();
    expect(() => checkEgressHosts(config, want.slice(1).join(","))).toThrow(/Set it to/);
    expect(() => checkEgressHosts(config, [...want, "evil.example"].join(","))).toThrow(
      /doesn't match/,
    );
  });

  it("refuses providers that need a cloud account", () => {
    expect(() =>
      localSettings(
        parseDeployConfig({
          ...base,
          providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
        }),
      ),
    ).toThrow(/can't use claude \(bedrock\)/);
  });
});

describe("secret files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lgtmoose-secrets-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps each secret in a file named after it, and refuses other names", () => {
    expect(secretFile(dir, "lgtmoose/github-app")).toBe(join(dir, "lgtmoose__github-app"));
    for (const bad of ["../x", "..", ".hidden", "a b", "a\\b"]) {
      expect(() => secretFile(dir, bad)).toThrow(/Not a secret name/);
    }
  });

  it("reads, versions and replaces a credential", async () => {
    const secrets = fileCredentialSecrets(dir);
    expect(await readSecretFile(dir, "lgtmoose/providers/x")).toBeUndefined();
    expect((await secrets.describe("lgtmoose/providers/x")).exists).toBe(false);
    await writeFile(secretFile(dir, "lgtmoose/providers/x"), "token-1\n");
    const before = await secrets.describe("lgtmoose/providers/x");
    expect(before.exists).toBe(true);
    expect(await secrets.read("lgtmoose/providers/x")).toBe("token-1");
    const version = await secrets.write("lgtmoose/providers/x", "token-2", "req");
    expect(version).not.toBe(before.currentVersion);
    expect((await secrets.describe("lgtmoose/providers/x")).currentVersion).toBe(version);
    expect(await readFile(secretFile(dir, "lgtmoose/providers/x"), "utf8")).toBe("token-2");
    expect((await stat(secretFile(dir, "lgtmoose/providers/x"))).mode & 0o777).toBe(0o600);
  });
});
