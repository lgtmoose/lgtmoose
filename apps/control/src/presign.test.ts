import { batchTranscriptKeys, batchUrlsSchema, runKeys } from "@lgtmoose/pipeline";
import { describe, expect, it } from "vitest";
import { checkOutcome, presignBatch } from "./presign.js";

const RUN_ID = "0b6f6d8e-3c1a-4c3e-9a51-6f1f0e0c2a11";

function deps() {
  const signed: { method: string; key: string; expires: number }[] = [];
  const objects = new Map<string, string>();
  return {
    signed,
    objects,
    deps: {
      presign: async (method: "GET" | "PUT", key: string, expires: number) => {
        signed.push({ method, key, expires });
        return `https://bucket.s3.eu-west-1.amazonaws.com/${key}?method=${method}`;
      },
      putText: async (key: string, body: string) => {
        objects.set(key, body);
      },
    },
  };
}

describe("presignBatch", () => {
  it("writes the batch's URLs to urls.json and returns a GET for it", async () => {
    const d = deps();
    const keys = runKeys(RUN_ID);
    const result = await presignBatch(d.deps, { runId: RUN_ID, index: 2 }, 900);

    expect(result.urls).toContain(keys.batchUrls(2));
    const urls = batchUrlsSchema.parse(JSON.parse(d.objects.get(keys.batchUrls(2)) ?? ""));
    expect(urls.checkout).toContain(`${keys.checkout}?method=GET`);
    expect(urls.input).toContain(`${keys.batchInput(2)}?method=GET`);
    expect(urls.output).toContain(`${keys.batchOutput(2)}?method=PUT`);
    expect(Object.keys(urls.transcripts)).toEqual(batchTranscriptKeys(RUN_ID, 2));
    for (const url of Object.values(urls.transcripts)) expect(url).toContain("method=PUT");
    // Only this run's and batch's objects, all with the given expiry.
    for (const { key, expires } of d.signed) {
      expect(key === keys.checkout || key.startsWith(`runs/${RUN_ID}/batches/2/`)).toBe(true);
      expect(expires).toBe(900);
    }
    expect(d.signed.filter((s) => s.method === "PUT").map((s) => s.key)).not.toContain(
      keys.checkout,
    );
  });

  it("adds a PUT for the refreshed credential only when asked", async () => {
    const d = deps();
    const keys = runKeys(RUN_ID);
    await presignBatch(d.deps, { runId: RUN_ID, index: 1 }, 900);
    expect(JSON.parse(d.objects.get(keys.batchUrls(1)) ?? "").credential).toBeUndefined();
    await presignBatch(d.deps, { runId: RUN_ID, index: 1, credentialRefresh: true }, 900);
    const urls = batchUrlsSchema.parse(JSON.parse(d.objects.get(keys.batchUrls(1)) ?? ""));
    expect(urls.credential).toContain(`${keys.batchCredential(1)}?method=PUT`);
  });

  it("refuses anything but a run ID and a batch index", async () => {
    const d = deps();
    for (const event of [
      { runId: "../other", index: 0 },
      { runId: RUN_ID, index: -1 },
      { runId: RUN_ID, index: 0, extra: 1 },
    ]) {
      await expect(presignBatch(d.deps, event as never, 900)).rejects.toThrow();
    }
    expect(d.signed).toEqual([]);
  });
});

describe("checkOutcome", () => {
  const event = { action: "outcome" as const, runId: RUN_ID, index: 2, providerId: "claude" };
  const reading = (text: string | undefined) => {
    const read: string[] = [];
    const logs: Record<string, unknown>[] = [];
    return {
      read,
      logs,
      deps: {
        getText: async (key: string) => {
          read.push(key);
          return text;
        },
        log: (_message: string, fields: Record<string, unknown>) => logs.push(fields),
      },
    };
  };
  const output = (fields: Record<string, unknown>) =>
    JSON.stringify({ version: 1, index: 2, transcriptKeys: [], ...fields });

  it("reads only this batch's output, and falls back after a plan limit", async () => {
    const r = reading(output({ error: "plan_limit: usage limit reached" }));
    await expect(checkOutcome(r.deps, event)).resolves.toEqual({ fallback: true });
    expect(r.read).toEqual([runKeys(RUN_ID).batchOutput(2)]);
    expect(r.logs[0]).toMatchObject({ providerId: "claude", reason: "plan_limit" });
  });

  it("keeps a reviewed batch, and one that failed in a way another provider would too", async () => {
    await expect(checkOutcome(reading(output({ findings: [] })).deps, event)).resolves.toEqual({
      fallback: false,
    });
    await expect(
      checkOutcome(reading(output({ error: "timeout: slow" })).deps, event),
    ).resolves.toEqual({ fallback: false });
  });

  it("falls back when the batch left no output", async () => {
    await expect(checkOutcome(reading(undefined).deps, event)).resolves.toEqual({
      fallback: true,
    });
  });

  it("refuses an event for anything but a run's batch", async () => {
    await expect(
      checkOutcome(reading(undefined).deps, { ...event, runId: "../etc" }),
    ).rejects.toThrow();
  });
});
