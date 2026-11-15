import { FUZZY_NOUN_SIMILARITY, isProtectedCategory, titleNouns } from "@lgtmoose/core";
import {
  MAX_LEARNING_TEXT,
  proposeLearning,
  type LearningDeps,
  type LearningStore,
  type ProposeResult,
} from "@lgtmoose/learnings";
import type { BatchJob } from "@lgtmoose/pipeline";

/**
 * Learning from outcomes (NIC-1081), without waiting for anyone to write `learn:`:
 *
 * - **Repeated rejections.** When findings of one rule category about the same thing (similar
 *   title nouns) are declined, disputed or 👎'd on `repeatThreshold` PRs of a repo (2 by
 *   default), a scoping learning is proposed from the findings and the people's reasons. It's
 *   written here in plain code, with no model call, and goes through the learnings policy: it's
 *   active only when every person who rejected one has write access, and pending otherwise.
 *   Protected categories are never proposed, and a pattern is proposed once.
 * - **Reinforcement.** A finding that gets fixed counts a hit for the learnings in its batch's
 *   prompt (`reinforced`). One that's rejected though a learning of its category was in the
 *   prompt is recorded as `not_followed`, for a person to sharpen or retire that learning.
 *
 * Learnings stay prompt context only: nothing here drops or downgrades a finding.
 */

export const DEFAULT_REPEAT_THRESHOLD = 2;
/** How far back rejected findings count towards a repeat. */
export const REPEAT_WINDOW_DAYS = 90;
/** The most reasons quoted in a learning made from a repeat, and the most of each. */
const MAX_REASONS = 3;
const MAX_REASON_CHARS = 200;

/** A finding as outcome learning reads it, from the database. */
export interface OutcomeFinding {
  id: string;
  /** owner/name */
  repo: string;
  prNumber: number;
  category: string;
  title: string;
  /** The learnings in its batch's prompt. */
  learningIds: readonly string[];
}

/** A finding of ours that people rejected: declined, disputed, or more 👎 than 👍. */
export interface RejectedFinding {
  findingId: string;
  prNumber: number;
  title: string;
  /** Who rejected it: the reply's author for a decline or dispute, and whoever 👎'd it. */
  rejectors: readonly string[];
  /** The replies that declined or disputed it (redacted when stored), newest first. */
  reasons: readonly { author: string; body: string }[];
  /** When it was last rejected. */
  at: Date;
}

export interface OutcomeStore {
  findings(ids: readonly string[]): Promise<OutcomeFinding[]>;
  /** The repo's findings of `category` rejected since `since`, newest first. */
  rejected(repo: string, category: string, since: Date): Promise<RejectedFinding[]>;
}

/** The pattern a finding is about: its category and its title's key nouns. */
export function patternKey(category: string, title: string): string {
  return `${category}:${titleNouns(title).join(" ")}`;
}

function parseKey(key: string): { category: string; nouns: string[] } {
  const at = key.indexOf(":");
  const nouns = key.slice(at + 1).trim();
  return { category: key.slice(0, at), nouns: nouns === "" ? [] : nouns.split(" ") };
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const all = new Set([...left, ...right]).size;
  return all === 0 ? 0 : shared / all;
}

/**
 * Whether two patterns are the same: the same category, and title nouns at least as alike as
 * the fingerprint's fuzzy match asks. A title with no key nouns matches nothing: too generic to
 * make a rule of.
 */
export function samePattern(a: string, b: string): boolean {
  const left = parseKey(a);
  const right = parseKey(b);
  if (left.category !== right.category) return false;
  if (left.nouns.length === 0 || right.nouns.length === 0) return false;
  return jaccard(left.nouns, right.nouns) >= FUZZY_NOUN_SIMILARITY;
}

/** The learnings in the prompt of the batch that reviewed `path` in this run. */
export function learningIdsFor(
  jobs: readonly Pick<BatchJob, "files" | "learningIds">[],
  path: string,
): string[] {
  const job = jobs.find((candidate) => candidate.files.includes(path));
  return job?.learningIds === undefined ? [] : [...job.learningIds];
}

const quote = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The text of a learning made from repeated rejections. Plain words; the policy redacts it. */
export function repeatLearningText(
  title: string,
  category: string,
  prs: readonly number[],
  reasons: readonly { body: string }[],
): string {
  const where = prs.map((number) => `#${number}`).join(", ");
  const head = `People here rejected findings like "${quote(title, 160)}" (${category}) on ${prs.length} pull requests (${where}). Don't raise this again unless the code shows a real problem the reasons below don't cover.`;
  const quoted = reasons
    .slice(0, MAX_REASONS)
    .map((reason) => `"${quote(reason.body, MAX_REASON_CHARS)}"`);
  const text = quoted.length === 0 ? head : `${head} Their reasons: ${quoted.join("; ")}`;
  return quote(text, MAX_LEARNING_TEXT);
}

/** The text of a learning made by `remember` from a declined finding and its reason. */
export function rememberText(
  finding: { title: string; ruleCategory: string },
  reason: string | undefined,
): string {
  const like = `Don't raise findings like "${quote(finding.title, 160)}" (${finding.ruleCategory}) in this repository`;
  if (reason === undefined || reason.trim() === "") {
    return quote(`${like}: people here declined it.`, MAX_LEARNING_TEXT);
  }
  return quote(
    `${like} unless the code shows a real problem the reason doesn't cover. The reason it was declined: "${quote(reason, 400)}"`,
    MAX_LEARNING_TEXT,
  );
}

export interface OutcomeDeps {
  store: OutcomeStore;
  /** The learnings policy, bound to the installation's GitHub access (`permissions`). */
  learnings: LearningDeps;
  /** `learnings.repeatThreshold`; `DEFAULT_REPEAT_THRESHOLD` when left out. */
  repeatThreshold?: number;
  log(message: string, fields?: Record<string, unknown>): void;
  now?: () => Date;
}

const SYSTEM_EVENT_KINDS = new Set(["accepted_pattern", "scoping", "correction", "convention"]);

/**
 * The learnings among `ids` that were about the finding's category: a rejected finding with one
 * of them in its prompt means the learning wasn't followed.
 */
async function aboutCategory(
  store: LearningStore,
  ids: readonly string[],
  category: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const id of new Set(ids)) {
    const learning = await store.get(id);
    if (learning?.category === category && SYSTEM_EVENT_KINDS.has(learning.kind)) {
      found.push(id);
    }
  }
  return found;
}

/** What `learnFromRejections` did for one finding. */
export type RejectionOutcome =
  { findingId: string; proposed: ProposeResult } | { findingId: string; skipped: string };

/**
 * After findings were rejected: records the learnings in their prompts that weren't followed,
 * and proposes a learning for a pattern rejected on enough PRs. Never throws for one finding;
 * the next is still handled.
 */
export async function learnFromRejections(
  deps: OutcomeDeps,
  findingIds: readonly string[],
  githubCommentIds: ReadonlyMap<string, number> = new Map(),
): Promise<RejectionOutcome[]> {
  if (findingIds.length === 0) return [];
  const now = deps.now?.() ?? new Date();
  const threshold = Math.max(2, deps.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD);
  const results: RejectionOutcome[] = [];
  const done = new Set<string>();
  for (const finding of await deps.store.findings(findingIds)) {
    try {
      const commentId = githubCommentIds.get(finding.id);
      const missed = await aboutCategory(
        deps.learnings.store,
        finding.learningIds,
        finding.category,
      );
      if (missed.length > 0) {
        await deps.learnings.store.recordOutcome(
          missed,
          {
            type: "not_followed",
            findingId: finding.id,
            ...(commentId === undefined ? {} : { githubCommentId: commentId }),
          },
          now,
        );
        deps.log("learning not followed", { findingId: finding.id, learnings: missed });
      }
      results.push(await proposeForRepeat(deps, finding, threshold, now, done));
    } catch (error) {
      deps.log("outcome learning failed", {
        findingId: finding.id,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ findingId: finding.id, skipped: "failed" });
    }
  }
  return results;
}

async function proposeForRepeat(
  deps: OutcomeDeps,
  finding: OutcomeFinding,
  threshold: number,
  now: Date,
  done: Set<string>,
): Promise<RejectionOutcome> {
  const skip = (skipped: string): RejectionOutcome => ({ findingId: finding.id, skipped });
  // Never a rule that could quiet a protected category, however often it's rejected.
  if (isProtectedCategory(finding.category)) return skip("protected category");
  const key = patternKey(finding.category, finding.title);
  if (parseKey(key).nouns.length === 0) return skip("title too generic");
  // Two findings of one run with the same pattern make one proposal.
  if ([...done].some((other) => samePattern(other, key))) return skip("proposed this run");
  const repo = finding.repo.toLowerCase();
  const existing = await deps.learnings.store.patterned(repo);
  if (existing.some((learning) => samePattern(learning.patternKey ?? "", key))) {
    return skip("already learned");
  }
  const since = new Date(now.getTime() - REPEAT_WINDOW_DAYS * 86_400_000);
  const like = (await deps.store.rejected(repo, finding.category, since)).filter((rejected) =>
    samePattern(patternKey(finding.category, rejected.title), key),
  );
  const prs = [...new Set(like.map((rejected) => rejected.prNumber))].sort((a, b) => a - b);
  if (prs.length < threshold) return skip(`rejected on ${prs.length} of ${threshold} PRs`);
  const rejectors = [...new Set(like.flatMap((rejected) => rejected.rejectors))];
  // Every rejection counts: one by someone without write access, and a person approves it.
  const permissions = await Promise.all(
    rejectors.map((login) => deps.learnings.permissions(repo, login)),
  );
  const allWrite = permissions.every((permission) =>
    ["admin", "maintain", "write"].includes(permission),
  );
  const [first] = rejectors;
  if (first === undefined) return skip("nobody to attribute it to");
  const newest = like[0];
  // The newest rejection's author proposes it; the policy reads their access from GitHub.
  const author = newest?.reasons[0]?.author ?? newest?.rejectors[0] ?? first;
  const proposed = await proposeLearning(
    deps.learnings,
    {
      kind: "scoping",
      category: finding.category,
      text: repeatLearningText(
        finding.title,
        finding.category,
        prs,
        like.flatMap((rejected) => rejected.reasons),
      ),
      scope: { level: "repo" },
    },
    // No comment ID: the learning is the rejections', not one comment's (one of those comments
    // may already be the source of a learning the reply judge proposed).
    { repo, pr: newest?.prNumber ?? finding.prNumber, author },
    { requireApproval: !allWrite, patternKey: key },
  );
  done.add(key);
  deps.log("learning proposed from repeated rejections", {
    findingId: finding.id,
    prs,
    outcome: proposed.outcome,
    ...(proposed.outcome === "refused" ? { reason: proposed.reason } : {}),
  });
  return { findingId: finding.id, proposed };
}

/** After findings were fixed: a hit for each learning in their prompts (`reinforced`). */
export async function learnFromFixes(
  deps: Pick<OutcomeDeps, "store" | "log" | "now"> & { learnings: Pick<LearningDeps, "store"> },
  fixes: readonly { findingId: string; commentId?: number }[],
): Promise<number> {
  if (fixes.length === 0) return 0;
  const now = deps.now?.() ?? new Date();
  const comments = new Map(fixes.map((fix) => [fix.findingId, fix.commentId]));
  let reinforced = 0;
  for (const finding of await deps.store.findings(fixes.map((fix) => fix.findingId))) {
    if (finding.learningIds.length === 0) continue;
    const commentId = comments.get(finding.id);
    await deps.learnings.store.recordOutcome(
      finding.learningIds,
      {
        type: "reinforced",
        findingId: finding.id,
        ...(commentId === undefined ? {} : { githubCommentId: commentId }),
      },
      now,
    );
    reinforced += 1;
  }
  if (reinforced > 0) deps.log("learnings reinforced", { findings: reinforced });
  return reinforced;
}
