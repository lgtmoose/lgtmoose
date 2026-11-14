import { EMBEDDING_DIMENSIONS } from "@lgtmoose/db";
import { z } from "zod";
import type { Embedder } from "./retrieval.js";

/**
 * The embeddings providers a deployment can configure. Each sends learning text and batch diffs
 * to that provider: Amazon Bedrock in the deployment's own account, or OpenAI's embeddings API
 * with a key the operator stored. Without one, learnings are ranked by keyword, with no network.
 */

export const DEFAULT_BEDROCK_EMBEDDINGS_MODEL = "amazon.titan-embed-text-v2:0";
export const DEFAULT_OPENAI_EMBEDDINGS_MODEL = "text-embedding-3-small";

/** Calls a Bedrock model with a JSON body and returns its JSON reply (`InvokeModel`). */
export type BedrockInvoke = (modelId: string, body: string) => Promise<string>;

const titanReply = z.object({ embedding: z.array(z.number()) });

/**
 * Amazon Titan Text Embeddings (v2) on Bedrock: one call per text, at `EMBEDDING_DIMENSIONS`,
 * normalized. `invoke` is the deployment's Bedrock client, in its own account.
 */
export function bedrockTitanEmbedder(
  invoke: BedrockInvoke,
  model: string = DEFAULT_BEDROCK_EMBEDDINGS_MODEL,
): Embedder {
  return {
    model: `bedrock:${model}`,
    async embed(texts) {
      const vectors: number[][] = [];
      for (const text of texts) {
        const reply = await invoke(
          model,
          JSON.stringify({ inputText: text, dimensions: EMBEDDING_DIMENSIONS, normalize: true }),
        );
        vectors.push(titanReply.parse(JSON.parse(reply)).embedding);
      }
      return vectors;
    },
  };
}

const openAiReply = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * OpenAI's embeddings API (`text-embedding-3-*`, which take `dimensions`). The key is sent only
 * to `baseUrl`; it's never logged, and an error says the status, not the reply.
 */
export function openAiEmbedder(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): Embedder {
  const model = options.model ?? DEFAULT_OPENAI_EMBEDDINGS_MODEL;
  const url = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/embeddings`;
  const fetchFn = options.fetch ?? ((target: string, init: RequestInit) => fetch(target, init));
  return {
    model: `openai:${model}`,
    async embed(texts) {
      if (texts.length === 0) return [];
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: texts, dimensions: EMBEDDING_DIMENSIONS }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      if (!response.ok) {
        throw new Error(`the OpenAI embeddings API answered ${response.status}`);
      }
      const { data } = openAiReply.parse(await response.json());
      const vectors: number[][] = [];
      for (const entry of data) vectors[entry.index] = entry.embedding;
      return Array.from({ length: texts.length }, (_, i) => vectors[i] ?? []);
    },
  };
}
