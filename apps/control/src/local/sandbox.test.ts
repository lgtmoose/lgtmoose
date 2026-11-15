import { runKeys, type BatchOutput } from "@lgtmoose/pipeline";
import { describe, expect, it } from "vitest";
import type { CredentialSecrets } from "../credentials.js";
import type { SandboxContainer } from "./docker.js";
import {
  dockerBatchRunner,
  LOCAL_BATCH_ORIGIN,
  removeStrandedSandboxes,
  type SandboxProvider,
} from "./sandbox.js";
import { readTar, writeTar } from "./tar.js";

const RUN = "0f0f0f0f-1111-4222-8333-444455556666";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000";

/** An in-memory artifact store with the conditional writes the broker's leases use. */
function memoryStore() {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  let n = 0;
  const etag = () => `e${(n += 1)}`;
  return {
    objects,
    async getText(key: string) {
      return objects.get(key)?.body.toString("utf8");
    },
    async putText(key: string, body: string) {
      objects.set(key, { body: Buffer.from(body), etag: etag() });
    },
    async getObject(key: string) {
      const object = objects.get(key);
      return object === undefined ? undefined : { body: object.body };
    },
    async createText(key: string, body: string) {
      if (objects.has(key)) return undefined;
      const tag = etag();
      objects.set(key, { body: Buffer.from(body), etag: tag });
      return tag;
    },
    async replaceText(key: string, body: string, current: string) {
      if (objects.get(key)?.etag !== current) return undefined;
      const tag = etag();
      objects.set(key, { body: Buffer.from(body), etag: tag });
      return tag;
    },
    async getTagged(key: string) {
      const object = objects.get(key);
      return object === undefined ? undefined : { text: object.body.toString(), etag: object.etag };
    },
    async deleteIfMatch(key: string, current: string) {
      if (objects.get(key)?.etag === current) objects.delete(key);
    },
  };
}

interface Created {
  id: string;
  spec: SandboxContainer;
  copiedIn: Map<string, Buffer>;
  removed: boolean;
}

/**
 * A Docker stand-in. `behave` plays the sandbox: given the files copied in and the container's
 * environment, it returns the files the sandbox wrote, keyed by name under `io/`.
 */
function fakeDocker(
  behave: (files: Map<string, Buffer>, env: Record<string, string>) => Record<string, string>,
) {
  const created: Created[] = [];
  const written = new Map<string, Record<string, string>>();
  return {
    created,
    docker: {
      async createSandbox(spec: SandboxContainer) {
        const id = `c${created.length + 1}`;
        created.push({ id, spec, copiedIn: new Map(), removed: false });
        return id;
      },
      async putArchive(id: string, _path: string, tar: Buffer) {
        const container = created.find((c) => c.id === id);
        for (const [name, body] of readTar(tar, 1e9)) container?.copiedIn.set(name, body);
      },
      async start(id: string) {
        const container = created.find((c) => c.id === id);
        if (container !== undefined)
          written.set(id, behave(container.copiedIn, container.spec.env));
      },
      async wait() {
        return 0;
      },
      async logs() {
        return "";
      },
      async getArchive(id: string) {
        const files = written.get(id) ?? {};
        return writeTar(
          Object.entries(files).map(([name, body]) => ({
            name: `io/${name}`,
            body: Buffer.from(body),
            mode: 0o600,
            uid: 10001,
            gid: 10001,
          })),
        );
      },
      async remove(id: string) {
        const container = created.find((c) => c.id === id);
        if (container !== undefined) container.removed = true;
      },
    },
  };
}

const keys = runKeys(RUN);
const name = (key: string) => encodeURIComponent(key);

function output(overrides: Partial<BatchOutput>): string {
  return JSON.stringify({ version: 1, index: 0, transcriptKeys: [], ...overrides });
}

const secrets = (values: Record<string, string>): CredentialSecrets => ({
  async describe(secretId) {
    const value = values[secretId];
    return {
      exists: value !== undefined,
      deleting: false,
      currentVersion: value === undefined ? undefined : `v-${value.length}`,
      currentSince: new Date(0),
    };
  },
  async read(secretId) {
    const value = values[secretId];
    if (value === undefined) throw new Error("missing");
    return value;
  },
  async write() {
    return "v2";
  },
});

const claude: SandboxProvider = {
  id: "claude",
  harness: "claude-code",
  auth: "oauth-token",
  model: "default",
  fastModel: "default",
  credential: { secretId: "lgtmoose/providers/claude", limit: 2 },
};
const codex: SandboxProvider = {
  id: "codex",
  harness: "codex",
  auth: "api-key",
  model: "default",
  fastModel: "default",
  credential: { secretId: "lgtmoose/providers/codex", limit: 2 },
};

async function setup(providers: SandboxProvider[], behave: Parameters<typeof fakeDocker>[0]) {
  const store = memoryStore();
  await store.putText(keys.batchInput(0), '{"input":true}');
  await store.putText(keys.checkout, "tarball");
  // Another run's objects, which no container may see.
  await store.putText(runKeys(OTHER).batchInput(0), "other run");
  const fake = fakeDocker(behave);
  const logs: string[] = [];
  const runner = dockerBatchRunner({
    docker: fake.docker,
    store,
    secrets: secrets({
      "lgtmoose/providers/claude": "claude-token",
      "lgtmoose/providers/codex": "codex-key",
    }),
    broker: {
      store,
      executionRunning: async () => true,
      leaseTtlMs: 60_000,
      now: Date.now,
      newToken: () => "token-0123456789abcdef",
      random: () => 0,
      audit: () => undefined,
      problem: () => undefined,
    },
    providers,
    image: "lgtmoose-sandbox:test",
    network: "lgtmoose-sandbox",
    runnerId: "runner-test",
    proxyUrl: "http://egress-proxy:3128",
    timeoutMs: 60_000,
    memoryBytes: 1 << 30,
    cpus: 1,
    leaseWaitMs: 0,
    sleep: async () => undefined,
    log: (message) => logs.push(message),
  });
  return { store, fake, logs, run: () => runner({ runId: RUN, index: 0, executionArn: "arn" }) };
}

describe("the docker batch runner", () => {
  it("copies in only its batch, gives only its provider's credential, and stores the output", async () => {
    const t = await setup([claude], () => ({
      [name(keys.batchOutput(0))]: output({ findings: [] }),
      // Not something the sandbox may write: dropped.
      [name(keys.batchInput(0))]: "tampered",
      [name(runKeys(OTHER).batchInput(0))]: "tampered",
    }));
    await t.run();

    const [container] = t.fake.created;
    expect([...(container?.copiedIn.keys() ?? [])].sort()).toEqual(
      [keys.batchUrls(0), keys.batchInput(0), keys.checkout].map((key) => `io/${name(key)}`).sort(),
    );
    expect(container?.spec).toMatchObject({
      network: "lgtmoose-sandbox",
      batchPath: "/batch",
      labels: { "lgtmoose.sandbox": "1", "lgtmoose.runner": "runner-test", "lgtmoose.run": RUN },
    });
    expect(container?.spec.env).toMatchObject({
      LGTMOOSE_PROVIDER: "claude",
      LGTMOOSE_PROVIDER_CREDENTIAL: "claude-token",
      LGTMOOSE_BATCH_DIR: "/batch/io",
      LGTMOOSE_BATCH_URLS: `${LOCAL_BATCH_ORIGIN}/${name(keys.batchUrls(0))}`,
      HTTPS_PROXY: "http://egress-proxy:3128",
    });
    expect(Object.values(container?.spec.env ?? {}).join(" ")).not.toContain("codex-key");
    expect(Object.keys(container?.spec.env ?? {}).some((key) => /GITHUB/.test(key))).toBe(false);
    // The URL set names only this batch's objects, by local URL.
    const urls = JSON.parse((await t.store.getText(keys.batchUrls(0))) ?? "{}") as Record<
      string,
      string
    >;
    expect(urls.input).toBe(`${LOCAL_BATCH_ORIGIN}/${name(keys.batchInput(0))}`);

    expect(JSON.parse((await t.store.getText(keys.batchOutput(0))) ?? "{}")).toMatchObject({
      findings: [],
    });
    expect(await t.store.getText(keys.batchInput(0))).toBe('{"input":true}');
    expect(await t.store.getText(runKeys(OTHER).batchInput(0))).toBe("other run");
    expect(container?.removed).toBe(true);
    // The lease was given back.
    expect([...t.store.objects.keys()].some((key) => key.startsWith("credentials/leases/"))).toBe(
      false,
    );
  });

  it("falls back to the next provider on a limit, and stops when one reviews", async () => {
    const t = await setup([claude, codex], (_files, env) =>
      env.LGTMOOSE_PROVIDER === "claude"
        ? { [name(keys.batchOutput(0))]: output({ error: "rate_limit: slow down" }) }
        : { [name(keys.batchOutput(0))]: output({ findings: [] }) },
    );
    await t.run();
    expect(t.fake.created.map((c) => c.spec.env.LGTMOOSE_PROVIDER)).toEqual(["claude", "codex"]);
    expect(t.fake.created.every((c) => c.removed)).toBe(true);
    expect(JSON.parse((await t.store.getText(keys.batchOutput(0))) ?? "{}")).toMatchObject({
      findings: [],
    });
  });

  it("doesn't fall back on a failure another provider would have too", async () => {
    const t = await setup([claude, codex], () => ({
      [name(keys.batchOutput(0))]: output({ error: "timeout: the model ran out of time" }),
    }));
    await t.run();
    expect(t.fake.created).toHaveLength(1);
  });

  it("moves on when no output comes back, and removes the container", async () => {
    const t = await setup([claude, codex], (_files, env) =>
      env.LGTMOOSE_PROVIDER === "claude"
        ? {}
        : { [name(keys.batchOutput(0))]: output({ findings: [] }) },
    );
    await t.run();
    expect(t.fake.created).toHaveLength(2);
    expect(t.fake.created.every((c) => c.removed)).toBe(true);
  });
});

describe("removeStrandedSandboxes", () => {
  it("removes this runner's and stopped runners' sandboxes, never a live runner's", async () => {
    const containers = [
      { id: "mine", labels: { "lgtmoose.sandbox": "1", "lgtmoose.runner": "runner-a" } },
      { id: "live", labels: { "lgtmoose.sandbox": "1", "lgtmoose.runner": "runner-b" } },
      { id: "stale", labels: { "lgtmoose.sandbox": "1", "lgtmoose.runner": "runner-c" } },
      // Started before sandboxes were labelled with their runner.
      { id: "unlabelled", labels: { "lgtmoose.sandbox": "1" } },
    ];
    const removed: string[] = [];
    const docker = {
      listByLabel: async (label: string) => (label === "lgtmoose.sandbox=1" ? containers : []),
      remove: async (id: string) => {
        removed.push(id);
      },
    };
    const live = new Set(["runner-a", "runner-b"]);
    expect(await removeStrandedSandboxes(docker, "runner-a", live)).toBe(3);
    expect(removed.sort()).toEqual(["mine", "stale", "unlabelled"]);
  });
});
