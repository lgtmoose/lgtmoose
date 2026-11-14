import type { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { s3ArtifactStore } from "./aws.js";

const named = (name: string) => Object.assign(new Error(name), { name });

describe("s3ArtifactStore.putTextIfAbsent", () => {
  it("writes only when there's no object yet, and says whether it did", async () => {
    const replies: (Error | undefined)[] = [
      undefined,
      named("PreconditionFailed"),
      named("ConditionalRequestConflict"),
      named("AccessDenied"),
    ];
    const send = vi.fn(async (_command: PutObjectCommand) => {
      const error = replies.shift();
      if (error) throw error;
      return {};
    });
    const store = s3ArtifactStore({ send } as unknown as S3Client, "bucket");
    expect(await store.putTextIfAbsent("k", "{}")).toBe(true);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "bucket",
      Key: "k",
      Body: "{}",
      IfNoneMatch: "*",
    });
    expect(await store.putTextIfAbsent("k", "{}")).toBe(false);
    expect(await store.putTextIfAbsent("k", "{}")).toBe(false);
    await expect(store.putTextIfAbsent("k", "{}")).rejects.toThrow("AccessDenied");
  });
});
