import { isProtectedCategory } from "@lgtmoose/core";
import { learningProposalSchema, type LearningProposal } from "./policy.js";
import { redactSensitive, type RedactionKind } from "./redact.js";
import { SYSTEM_ACTOR, type Learning, type LearningKind, type LearningStore } from "./store.js";

/**
 * Learnings from a repository's review history (NIC-1080). The bootstrapper's candidates go
 * through the same rules as any proposal (`learningProposalSchema`, protected categories,
 * redaction), with one difference: a bootstrap only ever proposes. Every candidate is stored as
 * `pending`, whoever wrote the comments it rests on, and becomes active only when a person with
 * the access its scope needs approves it (`approveLearning`). Its author is LGTMoose itself
 * (`SYSTEM_ACTOR`, permission `system`), so the per-author pending limit and the comment authors'
 * access play no part.
 */

/** Kinds that can quiet a finding, and so can't name a protected category. */
const SUPPRESSING_KINDS: ReadonlySet<LearningKind> = new Set([
  "accepted_pattern",
  "scoping",
  "correction",
]);

/** A candidate as plain code passes it on: from the bootstrapper, or from a lint config. */
export interface BootstrapProposal {
  kind: LearningKind;
  text: string;
  category?: string;
  /** Limits it to paths in the repository; the whole repository when left out. */
  pathGlob?: string;
}

export type BootstrapCheck =
  | { ok: true; proposal: LearningProposal; redacted: RedactionKind[] }
  | { ok: false; reason: string };

/**
 * Checks a candidate against the write policy's rules, and redacts its text: refused when it
 * doesn't validate or a kind that can quiet findings names a protected category.
 */
export function checkBootstrapProposal(candidate: BootstrapProposal): BootstrapCheck {
  const redacted = redactSensitive(candidate.text);
  const parsed = learningProposalSchema.safeParse({
    kind: candidate.kind,
    text: redacted.text,
    ...(candidate.category === undefined ? {} : { category: candidate.category }),
    scope:
      candidate.pathGlob === undefined
        ? { level: "repo" }
        : { level: "path", pathGlob: candidate.pathGlob },
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: `not a valid learning (${parsed.error.issues[0]?.message ?? "invalid"})`,
    };
  }
  const { kind, category } = parsed.data;
  if (category !== undefined && SUPPRESSING_KINDS.has(kind) && isProtectedCategory(category)) {
    return {
      ok: false,
      reason: `a ${kind} learning can't be about ${category}: findings in protected categories are never suppressed`,
    };
  }
  return { ok: true, proposal: parsed.data, redacted: redacted.found };
}

/**
 * A learning's text as compared for duplicates: lower case, whitespace and punctuation folded,
 * so "Use the query builder." and "use the query builder" are one learning.
 */
export function normalizedLearningText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A learning's identity for dedupe: its scope and normalised text. */
export function learningKey(learning: {
  repo: string | undefined;
  pathGlob: string | undefined;
  text: string;
}): string {
  return JSON.stringify([learning.repo ?? "", learning.pathGlob ?? "", normalizedLearningText(learning.text)]);
}

/**
 * Stores a checked bootstrap proposal for `repo` (owner/name) as pending, by LGTMoose. The
 * caller dedupes first (`learningKey` against the repo's learnings).
 */
export async function storeBootstrapLearning(
  store: Pick<LearningStore, "insert">,
  proposal: LearningProposal,
  repo: string,
): Promise<Learning> {
  const full = repo.trim().toLowerCase();
  const [owner = ""] = full.split("/");
  if (proposal.scope.level === "org") throw new Error("A bootstrap proposes repo learnings only.");
  const { learning } = await store.insert(
    {
      org: owner,
      repo: full,
      pathGlob: proposal.scope.level === "path" ? proposal.scope.pathGlob : undefined,
      kind: proposal.kind,
      category: proposal.category,
      text: proposal.text,
      status: "pending",
      sourceRepo: full,
      sourcePr: undefined,
      // None: the candidate rests on several comments, kept with its bootstrap item.
      sourceCommentId: undefined,
      author: SYSTEM_ACTOR,
      authorPermission: "system",
    },
    [{ type: "proposed", actor: SYSTEM_ACTOR, actorPermission: "system", githubCommentId: undefined }],
  );
  return learning;
}
