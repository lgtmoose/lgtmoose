import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_BATCH_ORIGIN, localBatchFetch, localBatchFile } from "./local-io.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lgtmoose-batch-io-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("local batch I/O", () => {
  it("maps only its own origin's single-segment names to files", () => {
    expect(localBatchFile(dir, `${LOCAL_BATCH_ORIGIN}/input.json`)).toBe(join(dir, "input.json"));
    expect(localBatchFile(dir, `${LOCAL_BATCH_ORIGIN}/runs%2Fa%2Fb.json`)).toBe(
      join(dir, "runs%2Fa%2Fb.json"),
    );
    for (const url of [
      "https://example.com/input.json",
      `${LOCAL_BATCH_ORIGIN}/../etc/passwd`,
      `${LOCAL_BATCH_ORIGIN}/a/b`,
      `${LOCAL_BATCH_ORIGIN}/.hidden`,
      `${LOCAL_BATCH_ORIGIN}/x..y`,
      `${LOCAL_BATCH_ORIGIN}/input.json?x=1`,
      "http://batch.invalid/input.json",
      "not a url",
    ]) {
      expect(localBatchFile(dir, url)).toBeUndefined();
    }
  });

  it("reads and writes the batch's files, and refuses anything else", async () => {
    const local = localBatchFetch(dir);
    await writeFile(join(dir, "input.json"), '{"a":1}');
    const got = await local(`${LOCAL_BATCH_ORIGIN}/input.json`);
    expect(await got.json()).toEqual({ a: 1 });

    const put = await local(`${LOCAL_BATCH_ORIGIN}/output.json`, { method: "PUT", body: "{}" });
    expect(put.ok).toBe(true);
    expect(await readFile(join(dir, "output.json"), "utf8")).toBe("{}");

    expect((await local(`${LOCAL_BATCH_ORIGIN}/missing.json`)).status).toBe(404);
    expect((await local("https://api.github.com/user")).status).toBe(403);
    expect((await local(`${LOCAL_BATCH_ORIGIN}/input.json`, { method: "DELETE" })).status).toBe(
      405,
    );
  });
});
