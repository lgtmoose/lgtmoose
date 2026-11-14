import type { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { s3ArtifactStore } from "./aws.js";

const named = (name: string) => Object.assign(new Error(name), { name });

function store(replies: (Error | Record<string, unknown>)[]) {
  const send = vi.fn(async (_command: PutObjectCommand | DeleteObjectCommand) => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? {};
  });
  return { send, store: s3ArtifactStore({ send } as unknown as S3Client, "bucket") };
}

describe("s3ArtifactStore conditional writes", () => {
  const object = (text: string, etag: string) => ({
    ETag: etag,
    Body: { transformToString: async () => text },
  });

  it("creates only when there's no object yet, and gives the new ETag", async () => {
    const s3 = store([{ ETag: '"e1"' }, named("PreconditionFailed"), object("theirs", '"e9"')]);
    expect(await s3.store.createText("k", "mine")).toBe('"e1"');
    expect(s3.send.mock.calls[0]?.[0].input).toMatchObject({ Key: "k", IfNoneMatch: "*" });
    expect(await s3.store.createText("k", "mine")).toBeUndefined();
  });

  it("takes a 412 as success when the object holds exactly what it wrote", async () => {
    // The SDK retried a write S3 had already applied; the retry got the 412.
    const s3 = store([named("PreconditionFailed"), object("mine", '"e2"')]);
    expect(await s3.store.createText("k", "mine")).toBe('"e2"');
    const replaced = store([named("PreconditionFailed"), object("mine", '"e3"')]);
    expect(await replaced.store.replaceText("k", "mine", '"e1"')).toBe('"e3"');
  });

  it("throws on a conditional write racing another, for the caller to retry", async () => {
    const s3 = store([named("ConditionalRequestConflict")]);
    await expect(s3.store.createText("k", "{}")).rejects.toThrow("ConditionalRequestConflict");
  });

  it("replaces only the version it read", async () => {
    const s3 = store([{ ETag: '"e2"' }, named("PreconditionFailed"), object("theirs", '"e9"')]);
    expect(await s3.store.replaceText("k", "mine", '"e1"')).toBe('"e2"');
    expect(s3.send.mock.calls[0]?.[0].input).toMatchObject({ IfMatch: '"e1"' });
    expect(await s3.store.replaceText("k", "mine", '"e1"')).toBeUndefined();
  });

  it("deletes only the version it holds, and leaves one that changed", async () => {
    const s3 = store([{}, named("PreconditionFailed"), named("AccessDenied")]);
    await s3.store.deleteIfMatch("k", '"e1"');
    expect(s3.send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "bucket",
      Key: "k",
      IfMatch: '"e1"',
    });
    await s3.store.deleteIfMatch("k", '"e1"');
    await expect(s3.store.deleteIfMatch("k", '"e1"')).rejects.toThrow("AccessDenied");
  });
});
