import {
  bedrockTitanEmbedder,
  openAiEmbedder,
  retrieveLearnings,
  summarizeLearning,
  type BedrockInvoke,
  type Embedder,
  type LearningStore,
} from "@lgtmoose/learnings";
import type { EmbeddingsSettings } from "./env.js";
import type { ControlDeps } from "./ports.js";

/**
 * Learnings in the control task: the prepare step asks for each batch's learnings here, so the
 * store and the embeddings provider are only ever reached from the control task, which already
 * holds the database. The sandbox only sees the learnings' text in its prompt.
 */

/** The embedder `settings` name; undefined for `none` (keyword ranking, no network). */
export async function embedderFor(
  settings: EmbeddingsSettings,
  io: {
    /** Bedrock `InvokeModel` in this account. */
    bedrock: () => BedrockInvoke;
    /** A secret's plain-text value. */
    secret: (arn: string) => Promise<string>;
  },
): Promise<Embedder | undefined> {
  switch (settings.provider) {
    case "none":
      return undefined;
    case "bedrock":
      return bedrockTitanEmbedder(io.bedrock(), settings.model);
    case "openai": {
      const apiKey = (await io.secret(settings.secretArn)).trim();
      if (apiKey === "") throw new Error("The OpenAI embeddings secret is empty.");
      return openAiEmbedder({ apiKey, model: settings.model });
    }
  }
}

/** `ControlDeps.learnings` from the store and the embedder: logs how each batch was ranked. */
export function learningsRetriever(
  store: LearningStore,
  embedder: Embedder | undefined,
  log: ControlDeps["log"],
): NonNullable<ControlDeps["learnings"]> {
  return async ({ org, repo, paths, diff }) => {
    const { learnings, ranking } = await retrieveLearnings(
      { store, ...(embedder === undefined ? {} : { embedder }), log },
      { org, repo, paths, text: diff },
    );
    if (learnings.length > 0) {
      log("learnings added to a batch", {
        repo,
        ranking,
        ids: learnings.map((learning) => learning.id),
      });
    }
    return learnings.map((learning) => {
      const { kind, category, scope, text } = summarizeLearning(learning);
      return { kind, category, scope, text };
    });
  };
}
