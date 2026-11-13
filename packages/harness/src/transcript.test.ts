import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { MemoryTranscriptStore, S3TranscriptStore, transcriptKey } from "./transcript.js";

describe("transcriptKey", () => {
  it("groups attempts by run", () => {
    expect(transcriptKey("run-1", 2)).toBe("transcripts/run-1/2.jsonl");
  });
});

describe("S3TranscriptStore", () => {
  it("puts the transcript with PutObject", async () => {
    const sent: PutObjectCommand[] = [];
    const store = new S3TranscriptStore({
      bucket: "artifacts",
      prefix: "reviews/",
      client: {
        send: (command) => {
          sent.push(command);
          return Promise.resolve({});
        },
      },
    });
    await store.put("transcripts/r/1.jsonl", '{"type":"result"}\n');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0]?.input).toEqual({
      Bucket: "artifacts",
      Key: "reviews/transcripts/r/1.jsonl",
      Body: '{"type":"result"}\n',
      ContentType: "application/x-ndjson",
    });
  });

  it("passes S3 errors on", async () => {
    const store = new S3TranscriptStore({
      bucket: "b",
      client: { send: () => Promise.reject(new Error("AccessDenied")) },
    });
    await expect(store.put("k", "x")).rejects.toThrow("AccessDenied");
  });
});

describe("MemoryTranscriptStore", () => {
  it("keeps what was put", async () => {
    const store = new MemoryTranscriptStore();
    await store.put("k", "body");
    expect(store.objects.get("k")).toBe("body");
  });
});
