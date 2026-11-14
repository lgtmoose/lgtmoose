import { describe, expect, it } from "vitest";
import { bedrockTitanEmbedder, openAiEmbedder } from "./embedders.js";

describe("bedrockTitanEmbedder", () => {
  it("asks Titan for 1024 normalized dimensions, one call per text", async () => {
    const calls: [string, unknown][] = [];
    const embedder = bedrockTitanEmbedder(async (modelId, body) => {
      calls.push([modelId, JSON.parse(body)]);
      return JSON.stringify({ embedding: [0.5, 0.5], inputTextTokenCount: 2 });
    });
    expect(embedder.model).toBe("bedrock:amazon.titan-embed-text-v2:0");
    expect(await embedder.embed(["a", "b"])).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    expect(calls).toEqual([
      ["amazon.titan-embed-text-v2:0", { inputText: "a", dimensions: 1024, normalize: true }],
      ["amazon.titan-embed-text-v2:0", { inputText: "b", dimensions: 1024, normalize: true }],
    ]);
  });
});

describe("openAiEmbedder", () => {
  it("sends the key only in the header and orders vectors by index", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const embedder = openAiEmbedder({
      apiKey: "sk-test-key",
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [2] },
              { index: 0, embedding: [1] },
            ],
          }),
          { status: 200 },
        );
      },
    });
    expect(embedder.model).toBe("openai:text-embedding-3-small");
    expect(await embedder.embed(["x", "y"])).toEqual([[1], [2]]);
    const [request] = requests;
    expect(request?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(JSON.parse(request?.init.body as string)).toEqual({
      model: "text-embedding-3-small",
      input: ["x", "y"],
      dimensions: 1024,
    });
    expect(request?.init.body as string).not.toContain("sk-test-key");
  });

  it("reports a failed call by its status, not its reply", async () => {
    const embedder = openAiEmbedder({
      apiKey: "sk-test-key",
      fetch: async () => new Response("invalid key sk-test-key", { status: 401 }),
    });
    await expect(embedder.embed(["x"])).rejects.toThrow("the OpenAI embeddings API answered 401");
  });
});
