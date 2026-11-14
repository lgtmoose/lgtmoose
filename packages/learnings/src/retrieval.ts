import { EMBEDDING_DIMENSIONS } from "@lgtmoose/db";
import picomatch from "picomatch";
import { SYSTEM_ACTOR, type Learning, type LearningStore } from "./store.js";

/**
 * Retrieval: which active learnings a review batch's prompt gets, and the upkeep around them.
 *
 * - **Scope first.** A learning applies to a batch when it's the PR's org's and either org-wide,
 *   or the PR's repo's and, with a path glob, the glob matches one of the batch's files.
 * - **Then ranked**, by embedding similarity to the batch's diff (pgvector cosine distance) when
 *   an `Embedder` is configured, else by shared keywords. The top `limit` (15) go in the prompt.
 * - **Learnings are context, never a filter.** Nothing here drops or downgrades a finding: the
 *   reviewer reads them as untrusted context (see `renderLearnings` in @lgtmoose/roles), and the
 *   prompt says they can't relax protected categories. Code that ever lets a learning suppress a
 *   finding must call `mayLearningSuppress` for each finding.
 * - **Use is counted**: `hits` and `lastUsedAt` go up for each learning put in a prompt, and
 *   `retireUnusedLearnings` retires active ones unused for 90 days, with a `retired` event by
 *   LGTMoose itself, so their history stays.
 */

/** How many learnings a batch's prompt gets at most. */
export const LEARNINGS_PER_BATCH = 15;

/** Learnings unused this many days are retired. */
export const RETIRE_UNUSED_DAYS = 90;

/** Diff text sent to the embedder is cut to this many characters (Titan v2 takes 8k tokens). */
export const MAX_QUERY_CHARS = 8000;

/**
 * Turns texts into vectors of `EMBEDDING_DIMENSIONS` numbers. `model` names the model the vectors
 * come from: stored with each vector, so vectors of different models are never compared.
 *
 * It sends the texts (learning text, and a batch's diff) to the embeddings provider the
 * deployment configured.
 */
export interface Embedder {
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** Where a review is: the PR's org and repo (owner/name), and the batch's files. */
export interface LearningScope {
  org: string;
  repo: string;
  /** The batch's paths (or the PR's, for `learningsForPullRequest`). */
  paths: readonly string[];
}

const GLOB_OPTIONS: picomatch.PicomatchOptions = { dot: true };

/** Whether a learning applies to `scope`: its org's, and org-wide or the repo's (and paths). */
export function appliesTo(learning: Learning, scope: LearningScope): boolean {
  if (learning.status !== "active") return false;
  if (learning.org.toLowerCase() !== scope.org.toLowerCase()) return false;
  if (learning.repo === undefined) return true;
  if (learning.repo.toLowerCase() !== scope.repo.toLowerCase()) return false;
  if (learning.pathGlob === undefined) return true;
  const matches = picomatch(learning.pathGlob, GLOB_OPTIONS);
  return scope.paths.some((path) => matches(path));
}

/**
 * The active learnings that apply to a PR's files, newest first: what the `learnings` command
 * lists. Nothing is counted as used.
 */
export async function learningsForPullRequest(
  store: LearningStore,
  scope: LearningScope,
): Promise<Learning[]> {
  const candidates = await store.list({
    org: scope.org.toLowerCase(),
    repo: scope.repo.toLowerCase(),
    status: "active",
  });
  return candidates.filter((learning) => appliesTo(learning, scope));
}

export interface RetrievalDeps {
  store: LearningStore;
  /** Undefined: no embeddings provider is configured, and keywords rank instead. */
  embedder?: Embedder;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface RetrievalQuery extends LearningScope {
  /** The batch's diff, to rank learnings against. */
  text: string;
  limit?: number;
}

export interface Retrieved {
  learnings: Learning[];
  /** How they were ranked: `none` when no learning applies. */
  ranking: "embedding" | "keyword" | "none";
}

/**
 * The learnings a batch's prompt gets: those that apply to its files, ranked against its diff,
 * the top `limit`. Each one returned is counted as used. An embedder that fails falls back to
 * keyword ranking, logged: a review never fails for its learnings.
 */
export async function retrieveLearnings(
  deps: RetrievalDeps,
  query: RetrievalQuery,
): Promise<Retrieved> {
  const limit = query.limit ?? LEARNINGS_PER_BATCH;
  const candidates = await learningsForPullRequest(deps.store, query);
  if (candidates.length === 0 || limit <= 0) return { learnings: [], ranking: "none" };
  let chosen: Learning[] | undefined;
  let ranking: Retrieved["ranking"] = "keyword";
  if (deps.embedder !== undefined) {
    try {
      chosen = await byEmbedding(deps.store, deps.embedder, candidates, query.text, limit);
      ranking = "embedding";
    } catch (error) {
      deps.log?.("learnings ranked by keyword: the embeddings provider failed", {
        model: deps.embedder.model,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  chosen ??= byKeyword(candidates, query.text, limit);
  await deps.store.recordUse(
    chosen.map((learning) => learning.id),
    (deps.now ?? (() => new Date()))(),
  );
  return { learnings: chosen, ranking };
}

/** One vector per text, each of `EMBEDDING_DIMENSIONS` finite numbers, or it throws. */
async function embedChecked(embedder: Embedder, texts: readonly string[]): Promise<number[][]> {
  const vectors = await embedder.embed(texts);
  if (vectors.length !== texts.length) {
    throw new Error(`the embedder returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
      throw new Error(
        `the embedder returned a vector of ${vector.length} numbers, not ${EMBEDDING_DIMENSIONS}`,
      );
    }
  }
  return vectors;
}

/** At most this many learning texts per embeddings call. */
const EMBED_CHUNK = 16;

async function byEmbedding(
  store: LearningStore,
  embedder: Embedder,
  candidates: readonly Learning[],
  text: string,
  limit: number,
): Promise<Learning[]> {
  const ids = candidates.map((learning) => learning.id);
  // Embedded the first time they're ranked with this model: a new learning, or a new model.
  const missing = new Set(await store.missingEmbeddings(ids, embedder.model));
  const toEmbed = candidates.filter((learning) => missing.has(learning.id));
  for (let i = 0; i < toEmbed.length; i += EMBED_CHUNK) {
    const chunk = toEmbed.slice(i, i + EMBED_CHUNK);
    const vectors = await embedChecked(
      embedder,
      chunk.map((learning) => learningText(learning)),
    );
    for (const [j, learning] of chunk.entries()) {
      const vector = vectors[j];
      if (vector !== undefined) await store.setEmbedding(learning.id, embedder.model, vector);
    }
  }
  const [vector] = await embedChecked(embedder, [text.slice(0, MAX_QUERY_CHARS)]);
  if (vector === undefined) throw new Error("the embedder returned no vector for the diff");
  const nearest = await store.nearest(ids, embedder.model, vector, limit);
  const byId = new Map(candidates.map((learning) => [learning.id, learning]));
  return nearest.flatMap((id) => byId.get(id) ?? []);
}

/** What's embedded, and matched by keyword, for a learning. */
function learningText(learning: Learning): string {
  return [learning.category, learning.text].filter((part) => part !== undefined).join(": ");
}

/** Common words that say nothing about what a learning or a diff is about. */
const STOPWORDS = new Set(
  "the and for are but not you all any can had her was one our out has have this that with from they will would there their what when which while into than then them these those such only also just use used uses using should must may might could does done like make made more most other some very each been being here where your about over under after before because".split(
    " ",
  ),
);

/** Lowercase words of three or more letters or digits, without stopwords. */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

/**
 * Ranks by the learning's keywords found in the diff, weighted down for long learnings; ties go
 * to the newer learning. No network: the fallback when no embedder is configured or it fails.
 */
export function byKeyword(
  candidates: readonly Learning[],
  text: string,
  limit: number,
): Learning[] {
  const diff = keywords(text);
  return candidates
    .map((learning, order) => {
      const words = keywords(learningText(learning));
      let shared = 0;
      for (const word of words) if (diff.has(word)) shared += 1;
      const score = words.size === 0 ? 0 : shared / Math.sqrt(words.size);
      return { learning, score, order };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.learning);
}

/**
 * Retires active learnings unused for `days` (90), with a `retired` event by LGTMoose itself
 * (`SYSTEM_ACTOR`, permission `system`): their rows and history stay, as with `forget`. Returns
 * how many it retired; at most `limit` per call, oldest first.
 */
export async function retireUnusedLearnings(
  store: LearningStore,
  options: { now?: Date; days?: number; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const days = options.days ?? RETIRE_UNUSED_DAYS;
  const before = new Date(now.getTime() - days * 86_400_000);
  const stale = await store.unusedSince(before, options.limit ?? 500);
  let retired = 0;
  for (const learning of stale) {
    const changed = await store.transition(learning.id, ["active"], "retired", {
      type: "retired",
      actor: SYSTEM_ACTOR,
      actorPermission: "system",
      githubCommentId: undefined,
    });
    if (changed !== undefined) retired += 1;
  }
  return retired;
}

/** How a learning is shown in a prompt or a reply: its scope, kind, category and text. */
export interface LearningSummary {
  id: string;
  kind: string;
  category: string | undefined;
  /** `org`, `repo`, or `path <glob>`. */
  scope: string;
  text: string;
}

export function summarizeLearning(learning: Learning): LearningSummary {
  let scope = "org";
  if (learning.repo !== undefined) {
    scope = learning.pathGlob === undefined ? "repo" : `path ${learning.pathGlob}`;
  }
  return {
    id: learning.id,
    kind: learning.kind,
    category: learning.category,
    scope,
    text: learning.text,
  };
}
