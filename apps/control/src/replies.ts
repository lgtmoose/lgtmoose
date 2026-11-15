import type { Judgement } from "@lgtmoose/core";
import { inline, paragraphs } from "@lgtmoose/summary";
import { needsTrustedResolver, resolutionHeld, type Permission } from "./thread-policy.js";

/**
 * The reply judge's policy (NIC-833): what LGTMoose does about a person's reply on one of its
 * findings' review threads, given the judge's answer. The judge is a model reading untrusted
 * text, so its answer only classifies; this code decides, and the rules that keep a merge
 * held are the same as for resolving a thread by hand (`thread-policy.ts`):
 *
 * - fixed: resolved only when the judge read the code at head and found the problem gone, and
 *   the finding's file changed since it was raised (so a reply alone can't clear it). Not
 *   fixed: one reply naming the line where it still is.
 * - declined: accepted (the finding declined, its thread resolved, and a learning proposed if
 *   the judge saw a general rule) when the person may decline it: anyone for a should_fix or
 *   nit, someone other than the PR's author with write access for a blocking or protected one.
 *   Otherwise one reply saying who can.
 * - disputed: re-checked by the judge. Still valid: one reply with the evidence, and never a
 *   second on the same finding. Wrong: a should_fix or nit is closed as disputed; a blocking or
 *   protected one stays open with one reply, since the judge's word alone never clears it.
 * - question: one short answer.
 * - other, or no judgement: nothing.
 *
 * At most one reply per finding per run: only its latest pending reply is judged.
 */

/** Marks our replies on GitHub, so they're never read as commands or judged as replies. */
export const JUDGE_REPLY_MARKER = "<!-- lgtmoose:reply -->";

/** The most replies judged in one run, unless the deploy config says otherwise. */
export const DEFAULT_MAX_REPLY_JUDGEMENTS = 10;

/** Runs that may fail to judge a reply before it's left alone. */
export const MAX_JUDGE_ATTEMPTS = 3;

/** A reply waiting for the judge (`pending_replies`). */
export interface PendingReply {
  id: string;
  findingId: string;
  /** The reply's review comment ID. */
  commentId: number;
  author: string;
  /** Redacted before it was stored; untrusted. */
  body: string;
  attempts: number;
}

/** `pending_replies`. */
export interface ReplyStore {
  /**
   * Records a reply on one of our findings' threads; false when that comment is already
   * recorded (a redelivery). `pullRequest` is the repo (owner/name) and number.
   */
  add(input: {
    repo: string;
    prNumber: number;
    findingId: string;
    commentId: number;
    author: string;
    body: string;
  }): Promise<boolean>;
  /**
   * The PR's pending replies to judge, oldest first, at most `limit`. Only each finding's
   * latest counts: older ones on the same finding are marked skipped here.
   */
  take(pullRequestId: string, limit: number): Promise<PendingReply[]>;
  /** Marks replies judged (acted on) or skipped. */
  finish(ids: readonly string[], status: "judged" | "skipped"): Promise<void>;
  /** Counts a failed judging; a reply past `MAX_JUDGE_ATTEMPTS` is skipped. */
  failed(ids: readonly string[]): Promise<void>;
}

/** Our finding a reply is about, as the policy reads it. */
export interface RepliedFinding {
  severity: "blocking" | "should_fix" | "nit";
  ruleCategory: string;
  path: string;
  status: string;
}

export interface ReplyContext {
  finding: RepliedFinding;
  /** The reply's author, from GitHub. */
  author: string;
  /** The PR's author, from GitHub. */
  prAuthor: string;
  /** The finding's file changed between the commit it was raised at and head (from git). */
  fileChanged: boolean;
  /** We already answered a dispute on this finding. */
  disputeAnswered: boolean;
  permission: (login: string) => Promise<Permission>;
}

/** What to do about one reply. */
export interface ReplyAction {
  /** The finding's new status; undefined leaves it as it is. */
  status?: "fixed" | "declined" | "disputed";
  /** Resolve the finding's thread on GitHub. */
  resolveThread: boolean;
  /** One reply in the thread (Markdown, already escaped, without our marker). */
  reply?: string;
  /** The event the reply is recorded as. */
  replyEvent?: "replied" | "dispute_answered";
  /** A learning to propose, as the person's (it goes through the learnings policy). */
  learning?: string;
  /** For the log. */
  reason: string;
}

const where = (path: string, line: number | undefined) =>
  line === undefined ? inline(path) : `${inline(path)} line ${line}`;

const said = (text: string | undefined) =>
  text === undefined || text.trim() === "" ? "" : `\n\n${paragraphs(text)}`;

/** Decides what to do about one reply from its judgement. Never throws on model output. */
export async function decideReply(
  judgement: Judgement | undefined,
  context: ReplyContext,
): Promise<ReplyAction> {
  const { finding } = context;
  if (finding.status !== "open" && finding.status !== "outdated") {
    return { resolveThread: false, reason: `the finding is already ${finding.status}` };
  }
  if (judgement === undefined) return { resolveThread: false, reason: "no judgement" };
  const guarded = needsTrustedResolver(finding);
  switch (judgement.kind) {
    case "fixed": {
      if (judgement.fixed_at_head === true && context.fileChanged) {
        return { status: "fixed", resolveThread: true, reason: "fixed at head" };
      }
      if (judgement.fixed_at_head === true) {
        // The judge says it's gone, but the file is as it was when the finding was raised: a
        // claim in the reply isn't enough.
        return {
          resolveThread: false,
          reply: `${inline(finding.path)} hasn't changed since this was raised, so it still counts. Push the fix and it's checked again.`,
          replyEvent: "replied",
          reason: "claimed fixed, file unchanged",
        };
      }
      return {
        resolveThread: false,
        reply: `This still looks unfixed at ${where(finding.path, judgement.line)}.${said(judgement.text)}`,
        replyEvent: "replied",
        reason: "not fixed at head",
      };
    }
    case "declined": {
      const held = await resolutionHeld(
        finding,
        context.author,
        context.prAuthor,
        context.permission,
      );
      if (held === undefined) {
        return {
          status: "declined",
          resolveThread: true,
          ...(judgement.learning === undefined || judgement.learning.trim() === ""
            ? {}
            : { learning: judgement.learning.trim() }),
          reason: "declined",
        };
      }
      return {
        resolveThread: false,
        reply:
          held === "author"
            ? "This finding holds the merge, so the pull request's author can't decline it. Someone else with write access can resolve this thread."
            : "This finding holds the merge, so only someone with write access can decline it.",
        replyEvent: "replied",
        reason: `decline held: ${held}`,
      };
    }
    case "disputed": {
      if (context.disputeAnswered) {
        return { resolveThread: false, reason: "dispute already answered" };
      }
      if (judgement.still_valid === false && !guarded) {
        return { status: "disputed", resolveThread: true, reason: "dispute upheld" };
      }
      if (judgement.still_valid === false) {
        return {
          resolveThread: false,
          reply: `Checked again: this may be wrong.${said(judgement.text)}\n\nIt holds the merge, so it still counts until someone other than the pull request's author, with write access, resolves this thread.`,
          replyEvent: "dispute_answered",
          reason: "dispute plausible, finding guarded",
        };
      }
      return {
        resolveThread: false,
        reply: `Checked again: this still applies at ${where(finding.path, judgement.line)}.${said(judgement.text)}`,
        replyEvent: "dispute_answered",
        reason: "dispute answered",
      };
    }
    case "question": {
      if (judgement.text === undefined || judgement.text.trim() === "") {
        return { resolveThread: false, reason: "question without an answer" };
      }
      return {
        resolveThread: false,
        reply: paragraphs(judgement.text),
        replyEvent: "replied",
        reason: "answered",
      };
    }
    case "other":
      return { resolveThread: false, reason: "nothing to do" };
  }
}

/** Replies with nothing to judge: emoji, thanks and the like. They're left alone. */
export function isTrivialReply(body: string): boolean {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\s.!,]/gu, "")
    .toLowerCase();
  if (text === "") return true;
  // "done" and "fixed" aren't here: they claim a fix, which is checked.
  return /^(thanks?|thankyou|thx|ty|ok(ay)?|lgtm|\+1?|ack|noted|cool|nice|great)$/.test(text);
}
