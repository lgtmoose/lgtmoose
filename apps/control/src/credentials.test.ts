import { runKeys } from "@lgtmoose/pipeline";
import { describe, expect, it } from "vitest";
import {
  CredentialBusyError,
  CredentialUnavailableError,
  OAUTH_TOKEN_WARN_AFTER_MS,
  acquireLease,
  checkCredentials,
  leaseKey,
  releaseLease,
  type BrokerCredential,
  type BrokerDeps,
  type CredentialSecrets,
} from "./credentials.js";

const RUN = "0f0e8c2a-4b1d-4c3e-9a7f-1234567890ab";
const OTHER_RUN = "1f0e8c2a-4b1d-4c3e-9a7f-1234567890ab";
const EXEC = "arn:aws:states:us-east-1:1:execution:review:a";
const OTHER_EXEC = "arn:aws:states:us-east-1:1:execution:review:b";
const SECRET = "arn:aws:secretsmanager:us-east-1:1:secret:lgtmoose/provider/codex";

function authJson(account: string, refresh: string): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id",
      access_token: `access-${refresh}`,
      refresh_token: refresh,
      account_id: account,
    },
    last_refresh: "2026-11-14T00:00:00Z",
  });
}

/** An in-memory bucket with ETags, conditional writes and deletes like S3's. */
function memoryStore() {
  const objects = new Map<string, { text: string; etag: string }>();
  let n = 0;
  const tag = () => `"${++n}"`;
  return {
    objects,
    put(key: string, text: string) {
      objects.set(key, { text, etag: tag() });
    },
    async createText(key: string, body: string) {
      if (objects.has(key)) return undefined;
      const etag = tag();
      objects.set(key, { text: body, etag });
      return etag;
    },
    async replaceText(key: string, body: string, etag: string) {
      if (objects.get(key)?.etag !== etag) return undefined;
      const next = tag();
      objects.set(key, { text: body, etag: next });
      return next;
    },
    async getTagged(key: string) {
      return objects.get(key);
    },
    async deleteIfMatch(key: string, etag: string) {
      if (objects.get(key)?.etag === etag) objects.delete(key);
    },
  };
}

function memorySecrets(value: string) {
  const state = {
    value,
    version: "v1",
    exists: true,
    deleting: false,
    since: new Date(0),
    writes: [] as { value: string; token: string }[],
  };
  const secrets: CredentialSecrets = {
    async describe() {
      return {
        exists: state.exists,
        deleting: state.deleting,
        currentVersion: state.exists ? state.version : undefined,
        currentSince: state.since,
      };
    },
    async read() {
      return state.value;
    },
    async write(_id, next, token) {
      state.writes.push({ value: next, token });
      state.value = next;
      state.version = `v${state.writes.length + 1}`;
      return state.version;
    },
  };
  return { state, secrets };
}

function setup(
  credential: Partial<BrokerCredential> = {},
  options: { running?: Set<string>; now?: number } = {},
) {
  const store = memoryStore();
  const { state, secrets } = memorySecrets(authJson("acct-1", "r1"));
  const audit: { event: string; fields: Record<string, unknown> }[] = [];
  const problems: { providerId: string; value: 0 | 1; reason?: string }[] = [];
  const clock = { now: options.now ?? 1_000_000 };
  let token = 0;
  const running = options.running ?? new Set([EXEC, OTHER_EXEC]);
  const deps: BrokerDeps = {
    store,
    secrets,
    executionRunning: async (arn) => running.has(arn),
    credentials: {
      codex: { secretId: SECRET, auth: "chatgpt-login", limit: 1, ...credential },
    },
    leaseTtlMs: 60_000,
    now: () => clock.now,
    newToken: () => `token-${String(++token).padStart(16, "0")}`,
    random: () => 0,
    audit: (event, fields) => audit.push({ event, fields }),
    problem: (providerId, value, reason) =>
      problems.push({ providerId, value, ...(reason === undefined ? {} : { reason }) }),
  };
  return { deps, store, state, audit, problems, clock, running };
}

const acquire = (deps: BrokerDeps, runId = RUN, index = 0, executionArn = EXEC) =>
  acquireLease(deps, { action: "acquire", providerId: "codex", runId, index, executionArn });

const release = (
  deps: BrokerDeps,
  lease: { slot: number; holder: string },
  runId = RUN,
  index = 0,
  output?: string,
) => releaseLease(deps, { action: "release", providerId: "codex", runId, index, lease }, output);

describe("acquireLease", () => {
  it("takes a free slot, recording the run, batch and secret version but no value", async () => {
    const { deps, store, audit } = setup({ limit: 2 });
    const lease = await acquire(deps);
    expect(lease.slot).toBe(0);
    const stored = JSON.parse(store.objects.get(leaseKey("codex", 0))!.text);
    expect(stored).toMatchObject({ runId: RUN, index: 0, executionArn: EXEC, versionId: "v1" });
    expect(audit).toEqual([
      {
        event: "credential lease taken",
        fields: expect.objectContaining({
          providerId: "codex",
          runId: RUN,
          slot: 0,
          versionId: "v1",
        }),
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("r1");
  });

  it("takes the next slot while the first is held, and is busy when all are", async () => {
    const { deps } = setup({ limit: 2 });
    expect((await acquire(deps, RUN, 0)).slot).toBe(0);
    expect((await acquire(deps, RUN, 1)).slot).toBe(1);
    await expect(acquire(deps, RUN, 2)).rejects.toBeInstanceOf(CredentialBusyError);
    await expect(acquire(deps, RUN, 2)).rejects.toMatchObject({ name: "Lgtmoose.CredentialBusy" });
  });

  it("takes over a lease that expired, or whose execution stopped", async () => {
    const { deps, clock, running, audit } = setup();
    await acquire(deps, OTHER_RUN, 0, OTHER_EXEC);
    await expect(acquire(deps)).rejects.toBeInstanceOf(CredentialBusyError);
    running.delete(OTHER_EXEC);
    expect((await acquire(deps)).slot).toBe(0);
    expect(audit.at(-1)).toMatchObject({
      event: "credential lease taken over",
      fields: { previousRunId: OTHER_RUN, previousIndex: 0 },
    });

    clock.now += 61_000;
    expect((await acquire(deps, OTHER_RUN, 3, OTHER_EXEC)).slot).toBe(0);
  });

  it("takes over its own batch's earlier attempt at once", async () => {
    const { deps } = setup();
    await acquire(deps, RUN, 4);
    expect((await acquire(deps, RUN, 4)).slot).toBe(0);
  });

  it("refuses a credential whose secret is missing or being deleted, and reports it", async () => {
    const { deps, state, problems } = setup();
    state.deleting = true;
    await expect(acquire(deps)).rejects.toBeInstanceOf(CredentialUnavailableError);
    state.exists = false;
    await expect(acquire(deps)).rejects.toMatchObject({ name: "Lgtmoose.CredentialUnavailable" });
    expect(problems.map((p) => p.value)).toEqual([1, 1]);
  });

  it("stores a stopped holder's refreshed auth.json when it takes the slot over", async () => {
    const { deps, store, state, running } = setup();
    await acquire(deps, OTHER_RUN, 2, OTHER_EXEC);
    const left = runKeys(OTHER_RUN).batchCredential(2);
    store.put(left, authJson("acct-1", "r2"));
    running.delete(OTHER_EXEC);
    await acquire(deps);
    expect(state.writes.map((w) => w.value)).toEqual([authJson("acct-1", "r2")]);
    expect(store.objects.has(left)).toBe(false);
  });
});

describe("releaseLease", () => {
  it("stores the refreshed auth.json while the batch holds its lease, then frees the slot", async () => {
    const { deps, store, state, audit } = setup();
    const lease = await acquire(deps);
    const key = runKeys(RUN).batchCredential(0);
    store.put(key, authJson("acct-1", "r2"));
    await release(deps, lease);
    expect(state.writes).toEqual([{ value: authJson("acct-1", "r2"), token: lease.holder }]);
    expect(store.objects.has(key)).toBe(false);
    expect(store.objects.has(leaseKey("codex", 0))).toBe(false);
    expect(audit.map((a) => a.event)).toContain("refreshed credential stored");
    expect(audit.at(-1)).toMatchObject({
      event: "credential lease given back",
      fields: { held: true, versionId: "v1", storedVersionId: "v2" },
    });
    expect(JSON.stringify(audit)).not.toContain("r2");
  });

  it("stores nothing and leaves the slot when the lease was taken over meanwhile", async () => {
    const { deps, store, state, clock } = setup();
    const lease = await acquire(deps);
    clock.now += 61_000;
    const next = await acquire(deps, OTHER_RUN, 0, OTHER_EXEC);
    const key = runKeys(RUN).batchCredential(0);
    store.put(key, authJson("acct-1", "r2"));
    await release(deps, lease);
    expect(state.writes).toEqual([]);
    expect(store.objects.has(key)).toBe(false);
    expect(JSON.parse(store.objects.get(leaseKey("codex", 0))!.text).holder).toBe(next.holder);
  });

  it("doesn't overwrite a secret that changed since the task started", async () => {
    const { deps, store, state, audit } = setup();
    const lease = await acquire(deps);
    state.version = "v9"; // lgtmoose auth codex, meanwhile
    store.put(runKeys(RUN).batchCredential(0), authJson("acct-1", "r2"));
    await release(deps, lease);
    expect(state.writes).toEqual([]);
    expect(audit.map((a) => a.event)).toContain(
      "refreshed credential not stored: the secret changed since the task started",
    );
  });

  it.each([
    ["another account's auth.json", authJson("acct-2", "r2")],
    ["something that isn't an auth.json", '{"tokens":{}}'],
    ["text that isn't JSON", "sk-not-json"],
  ])("refuses %s and reports a problem", async (_name, text) => {
    const { deps, store, state, problems } = setup();
    const lease = await acquire(deps);
    store.put(runKeys(RUN).batchCredential(0), text);
    await release(deps, lease);
    expect(state.writes).toEqual([]);
    expect(problems).toEqual([expect.objectContaining({ providerId: "codex", value: 1 })]);
    expect(store.objects.has(runKeys(RUN).batchCredential(0))).toBe(false);
  });

  it("reports a run refused for auth", async () => {
    const { deps, problems } = setup({ auth: "api-key", limit: 4 });
    const lease = await acquire(deps);
    await release(deps, lease, RUN, 0, JSON.stringify({ error: "auth: the key was refused" }));
    expect(problems).toEqual([
      { providerId: "codex", value: 1, reason: "a review run was refused for auth" },
    ]);
    const other = await acquire(deps);
    await release(deps, other, RUN, 0, JSON.stringify({ error: "rate_limit: slow down" }));
    expect(problems).toHaveLength(1);
  });

  it("never reads or writes the secret for credentials that don't refresh", async () => {
    const { deps, store, state } = setup({ auth: "api-key", limit: 4 });
    const lease = await acquire(deps);
    store.put(runKeys(RUN).batchCredential(0), authJson("acct-1", "r2"));
    deps.secrets.read = () => Promise.reject(new Error("read"));
    await release(deps, lease);
    expect(state.writes).toEqual([]);
  });
});

describe("checkCredentials", () => {
  it("reports each credential, flagging missing, deleting and year-old Claude tokens", async () => {
    const now = Date.UTC(2026, 10, 14);
    const problems: { providerId: string; value: 0 | 1; reason?: string | undefined }[] = [];
    const states: Record<string, Awaited<ReturnType<CredentialSecrets["describe"]>>> = {
      ok: { exists: true, deleting: false, currentVersion: "v", currentSince: new Date(now) },
      gone: { exists: false, deleting: false, currentVersion: undefined, currentSince: undefined },
      deleting: { exists: true, deleting: true, currentVersion: "v", currentSince: new Date(now) },
      old: {
        exists: true,
        deleting: false,
        currentVersion: "v",
        currentSince: new Date(now - OAUTH_TOKEN_WARN_AFTER_MS),
      },
    };
    const result = await checkCredentials({
      secrets: {
        describe: async (id) => states[id]!,
        read: () => Promise.reject(new Error("never read")),
        write: () => Promise.reject(new Error("never written")),
      },
      credentials: {
        a: { secretId: "ok", auth: "oauth-token", limit: 2 },
        b: { secretId: "gone", auth: "api-key", limit: 16 },
        c: { secretId: "deleting", auth: "api-key", limit: 16 },
        d: { secretId: "old", auth: "oauth-token", limit: 2 },
      },
      now: () => now,
      problem: (providerId, value, reason) => problems.push({ providerId, value, reason }),
    });
    expect(result.a).toBeUndefined();
    expect(result.b).toContain("doesn't exist");
    expect(result.c).toContain("scheduled for deletion");
    expect(result.d).toContain("expires soon");
    expect(problems.map((p) => [p.providerId, p.value])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 1],
      ["d", 1],
    ]);
  });
});
