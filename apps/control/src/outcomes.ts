import { batchOutputSchema, runKeys, type BatchOutcome } from "@lgtmoose/pipeline";
import type { ArtifactStore } from "./ports.js";

function withoutUndefined<T extends object>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/**
 * One batch's outcome from its output object. A missing object (the sandbox task failed or
 * never ran) is undefined; one that doesn't validate counts as a failed batch, never as a clean
 * one. The sandbox ran a model on PR content, so the output is checked like any model output.
 */
export async function readOutcome(
  store: ArtifactStore,
  runId: string,
  index: number,
): Promise<BatchOutcome | undefined> {
  const text = await store.getText(runKeys(runId).batchOutput(index));
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { index, error: "the batch output isn't JSON", transcriptKeys: [] };
  }
  const parsed = batchOutputSchema.safeParse(json);
  if (!parsed.success || parsed.data.index !== index) {
    return { index, error: "the batch output doesn't match its schema", transcriptKeys: [] };
  }
  const { findings, notes, error, transcriptKeys, usage } = parsed.data;
  return {
    index,
    ...(findings === undefined ? {} : { findings }),
    ...(notes === undefined ? {} : { notes }),
    ...(error === undefined ? {} : { error }),
    transcriptKeys,
    ...(usage === undefined ? {} : { usage: withoutUndefined(usage) }),
  };
}
