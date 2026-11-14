import type { Finding, Severity } from "@lgtmoose/core";
import type { PullComment } from "./pull.js";

/**
 * Other reviewers' findings (NIC-835): unresolved inline comments from other bots (CodeRabbit,
 * say) and from people with a say in the repository, on files this review covers, that mark a
 * real problem. They count towards the decision as open findings, and are listed in the
 * summary with who raised them. They're never posted again, never stored as ours, and never
 * shown to a model.
 *
 * Their text is untrusted. Only its opening words are read, for the severity the reviewer gave
 * it; none of it reaches a prompt or the summary. Nothing here can lower a severity or approve:
 * another reviewer's comment only ever adds an open finding.
 */
export interface OtherReviewerFinding {
  /** The finding as the decision and summary see it (`rule_category` `other_reviewer`). */
  finding: Finding;
  source: "bot" | "human";
  login: string;
  commentId: number;
}

/** A finding another reviewer raised on a file we reviewed, that none of ours is near. */
export interface ReviewerMiss {
  path: string;
  line: number;
  severity: Severity;
  source: "bot" | "human";
}

/** How a person's comment counts: only from someone with a say in the repository. */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** How much of a comment's start is read for its severity. */
const HEAD_LENGTH = 300;

/**
 * The severity another reviewer gave its comment, from its opening words, as review bots mark
 * them ("🔴 Critical", "🟠 Major", "Potential issue") and people write them ("Bug: …"). A
 * Critical one is blocking; a Major one or a bug report should be fixed. Anything else (a nit,
 * a refactor idea, a question) doesn't count.
 */
export function otherReviewerSeverity(body: string): Severity | undefined {
  const head = body.slice(0, HEAD_LENGTH).toLowerCase();
  // Whole words between non-letters: `\b` would miss markdown italics (`_Critical_`), since
  // `_` counts as a word character.
  const word = (text: string) => new RegExp(`(?<![a-z])${text}(?![a-z])`).test(head);
  if (word("critical")) return "blocking";
  if (word("major")) return "should_fix";
  if (word("potential issue") || word("bug")) return "should_fix";
  return undefined;
}

export interface OtherReviewerOptions {
  /** Paths at head this review covers: other comments elsewhere don't count. */
  paths: ReadonlySet<string>;
  /** IDs of comments that start a resolved review thread. */
  resolved: ReadonlySet<number>;
  /** Our App's ID: its own comments aren't another reviewer's. */
  ourAppId?: number;
  /** Our findings' comment IDs, ours whoever posted them. */
  ourCommentIds: ReadonlySet<number>;
}

/**
 * The PR's comments that count as other reviewers' open findings: on the diff as it is now
 * (GitHub still places them on a line), starting an unresolved thread, on a covered file, not
 * ours, from a bot or a person with a say in the repository, and marked Critical, Major or a
 * bug.
 */
export function otherReviewerFindings(
  comments: readonly PullComment[],
  options: OtherReviewerOptions,
): OtherReviewerFinding[] {
  const found: OtherReviewerFinding[] = [];
  for (const comment of comments) {
    const { id, path, line } = comment;
    if (id === undefined || path === undefined || line === undefined) continue;
    if (comment.inReplyTo !== undefined || options.resolved.has(id)) continue;
    if (!options.paths.has(path)) continue;
    if (options.ourCommentIds.has(id)) continue;
    if (options.ourAppId !== undefined && comment.viaAppId === options.ourAppId) continue;
    const source = comment.authorType ?? "human";
    if (source === "human" && !TRUSTED_ASSOCIATIONS.has(comment.association ?? "")) continue;
    const severity = otherReviewerSeverity(comment.body);
    if (severity === undefined) continue;
    // GitHub logins are letters, digits, `-` and a `[bot]` suffix; anything else is shown as
    // "unknown". The summary escapes the title besides.
    const login = /^[A-Za-z0-9-]+(\[bot\])?$/.test(comment.author) ? comment.author : "unknown";
    found.push({
      source,
      login,
      commentId: id,
      finding: {
        rule_category: "other_reviewer",
        severity,
        path,
        line,
        side: comment.side ?? "RIGHT",
        ...(comment.startLine === undefined ? {} : { start_line: comment.startLine }),
        title: `Raised by ${login} in their review comment`,
        body:
          comment.url !== undefined && /^https:\/\/[^\s)]+$/.test(comment.url)
            ? `See their comment: ${comment.url}`
            : "See their comment on this line.",
        evidence: "(their comment)",
      },
    });
  }
  return found;
}

/** How close one of our findings must be to count as the same catch. */
const NEAR = 3;

/**
 * Other reviewers' findings on files this run (or an earlier one) reviewed that none of our
 * findings, open or closed, is near: what the bot missed, for the evals.
 */
export function reviewerMisses(
  others: readonly OtherReviewerFinding[],
  reviewed: ReadonlySet<string>,
  ours: readonly Pick<Finding, "path" | "line">[],
): ReviewerMiss[] {
  return others.flatMap(({ finding, source }) => {
    if (!reviewed.has(finding.path)) return [];
    const caught = ours.some(
      (mine) => mine.path === finding.path && Math.abs(mine.line - finding.line) <= NEAR,
    );
    return caught
      ? []
      : [{ path: finding.path, line: finding.line, severity: finding.severity, source }];
  });
}
