import { batchTranscriptKeys, batchUrlsSchema, runKeys } from "@lgtmoose/pipeline";
import { describe, expect, it } from "vitest";
import { presignBatch } from "./presign.js";

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
