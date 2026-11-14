import { memoryLearningStore } from "@lgtmoose/learnings";
import { describe, expect, it } from "vitest";
import { readEmbeddingsSettings } from "./env.js";
import { embedderFor, learningsRetriever } from "./learnings.js";

describe("readEmbeddingsSettings", () => {
  it("reads none, bedrock and openai, and refuses what it can't use", () => {
    expect(readEmbeddingsSettings({})).toEqual({ provider: "none" });
    expect(readEmbeddingsSettings({ LGTMOOSE_EMBEDDINGS: "none" })).toEqual({ provider: "none" });
    expect(
      readEmbeddingsSettings({ LGTMOOSE_EMBEDDINGS: "bedrock:amazon.titan-embed-text-v2:0" }),
    ).toEqual({ provider: "bedrock", model: "amazon.titan-embed-text-v2:0" });
    expect(
      readEmbeddingsSettings({
        LGTMOOSE_EMBEDDINGS: "openai:text-embedding-3-small",
        LGTMOOSE_EMBEDDINGS_SECRET_ID: "arn:secret",
      }),
    ).toEqual({ provider: "openai", model: "text-embedding-3-small", secretArn: "arn:secret" });
    expect(() => readEmbeddingsSettings({ LGTMOOSE_EMBEDDINGS: "openai:x" })).toThrow(
      "LGTMOOSE_EMBEDDINGS_SECRET_ID",
    );
    expect(() => readEmbeddingsSettings({ LGTMOOSE_EMBEDDINGS: "bedrock" })).toThrow("model");
    expect(() => readEmbeddingsSettings({ LGTMOOSE_EMBEDDINGS: "cohere:x" })).toThrow("unknown");
  });
});

describe("embedderFor", () => {
  const io = {
    bedrock: () => async () => JSON.stringify({ embedding: [] }),
    secret: async () => " sk-test \n",
  };

  it("makes no embedder for none, and names each provider's model", async () => {
    expect(await embedderFor({ provider: "none" }, io)).toBeUndefined();
    expect((await embedderFor({ provider: "bedrock", model: "m" }, io))?.model).toBe("bedrock:m");
    expect(
      (
        await embedderFor(
          { provider: "openai", model: "text-embedding-3-small", secretArn: "a" },
          io,
        )
      )?.model,
    ).toBe("openai:text-embedding-3-small");
  });

  it("refuses an empty OpenAI key", async () => {
    await expect(
      embedderFor(
        { provider: "openai", model: "m", secretArn: "a" },
        { ...io, secret: async () => "  " },
      ),
    ).rejects.toThrow("empty");
  });
});

describe("learningsRetriever", () => {
  it("gives a batch the learnings for its repo and files, as prompt entries", async () => {
    const store = memoryLearningStore();
    await store.insert(
      {
        org: "acme",
        repo: "acme/shop",
        pathGlob: "src/**",
        kind: "convention",
        category: "money",
        text: "Amounts are in cents.",
        status: "active",
        sourceRepo: "acme/shop",
        sourcePr: 1,
        sourceCommentId: 1,
        author: "dana",
        authorPermission: "write",
      },
      [],
    );
    const logged: string[] = [];
    const retrieve = learningsRetriever(store, undefined, (message) => logged.push(message));
    expect(
      await retrieve({ org: "acme", repo: "acme/shop", paths: ["src/a.ts"], diff: "cents" }),
    ).toEqual([
      {
        kind: "convention",
        category: "money",
        scope: "path src/**",
        text: "Amounts are in cents.",
      },
    ]);
    expect(
      await retrieve({ org: "acme", repo: "acme/shop", paths: ["docs/a.md"], diff: "" }),
    ).toEqual([]);
    expect(logged).toEqual(["learnings added to a batch"]);
  });
});
