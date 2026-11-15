import type { Judgement } from "@lgtmoose/core";
import { inline } from "@lgtmoose/summary";
import { z } from "zod";
import {
  JUDGE_REPLY_MARKER,
  decideReply,
  type RepliedFinding,
  type ReplyStore,
} from "./replies.js";
import type { Permission } from "./thread-policy.js";

/**
 * The post step's two halves of acting on judged replies (`decideReply` has the policy):
 *
 * 1. `settleReplies`, before the decision: each judgement is decided, and the declined and
 *    disputed findings it closes are closed in the database, so the decision counts them closed.
 *    A fix is only a candidate: `confirmFixes` closes it once the run's own review, which read
 *    the file without our comment, didn't raise it again. What to write on GitHub is then saved
 *    once to the run's `replies.json`. A retried attempt reads that file back rather than
 *    deciding again: the findings it closed are no longer open, so deciding again would lose
 *    the writes.
 * 2. `writeReplies`, once the post holds its claim: the replies and thread resolutions are
 *    written, then the replies are marked judged.
 */

/** One judged reply, as the run's manifest has it (`JudgeJob`). */
export interface JudgedReply {
  index: number;
  replyId: string;
  findingId: string;
  commentId: number;
  author: string;
  fileChanged: boolean;
}

/** What to write on GitHub for the run's judged replies. */
export const replyWritesSchema = z.object({
  version: z.literal(1),
  /** Replies judged: marked so once written. */
  judged: z.array(z.string()),
  /** Replies the judge failed on: counted as an attempt, tried again by a later run. */
  failed: z.array(z.string()),
  /** Replies on findings closed since the run was prepared. */
  skipped: z.array(z.string()),
  writes: z.array(
    z.object({
      findingId: z.string(),
      /** The thread's first comment: where a reply goes. */
      threadRootId: z.number().int().positive().optional(),
      /** The thread's GraphQL node ID, to resolve it. */
      threadId: z.string().optional(),
      reply: z.string().optional(),
      replyEvent: z.enum(["replied", "dispute_answered"]).optional(),
      /** The person's reply, which the event names. */
      commentId: z.number().int().positive(),
      learning: z.string().optional(),
      author: z.string(),
    }),
  ),
  closed: z.number().int().min(0),
});

export type ReplyWrites = z.infer<typeof replyWritesSchema>;

export interface SettleDeps {
  /** The judge's answer for a batch; undefined when it failed or doesn't validate. */
  judgement(index: number): Promise<Judgement | undefined>;
  /** Our open and outdated findings on the PR. */
  findings: readonly (RepliedFinding & {
    id: string;
    fingerprint: string;
    githubCommentId: number | undefined;
  })[];
  /** A review thread's GraphQL node ID, by its first comment's ID. */
  threadId(firstCommentId: number): string | undefined;
  prAuthor: string;
  permission: (login: string) => Promise<Permission>;
  close(
    findingId: string,
    status: "fixed" | "declined" | "disputed",
    reply: { login: string; commentId: number },
  ): Promise<boolean>;
  disputesAnswered(ids: readonly string[]): Promise<Set<string>>;
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * A finding the judge says is fixed, not closed yet: the reviewer has the last word (see
 * `confirmFixes`).
 */
export interface FixCandidate {
  findingId: string;
  fingerprint: string;
  path: string;
  commentId: number;
  author: string;
  threadRootId?: number;
  threadId?: string;
}

/**
 * Decides each judged reply and closes the declined and disputed findings that allows.
 * Database only, no GitHub. A fix isn't closed here: it's a candidate for `confirmFixes`, once
 * the run's review is known.
 */
export async function settleReplies(
  judged: readonly JudgedReply[],
  deps: SettleDeps,
): Promise<{ writes: ReplyWrites; fixes: FixCandidate[] }> {
  const result: ReplyWrites = {
    version: 1,
    judged: [],
    failed: [],
    skipped: [],
    writes: [],
    closed: 0,
  };
  const fixes: FixCandidate[] = [];
  if (judged.length === 0) return { writes: result, fixes };
  const byId = new Map(deps.findings.map((finding) => [finding.id, finding]));
  const answered = await deps.disputesAnswered([
    ...new Set(judged.map((reply) => reply.findingId)),
  ]);
  for (const reply of judged) {
    const finding = byId.get(reply.findingId);
    if (finding === undefined) {
      result.skipped.push(reply.replyId);
      continue;
    }
    const judgement = await deps.judgement(reply.index);
    if (judgement === undefined) {
      result.failed.push(reply.replyId);
      continue;
    }
    const action = await decideReply(judgement, {
      finding,
      author: reply.author,
      prAuthor: deps.prAuthor,
      fileChanged: reply.fileChanged,
      disputeAnswered: answered.has(finding.id),
      permission: deps.permission,
    });
    deps.log("reply judged", {
      findingId: finding.id,
      commentId: reply.commentId,
      kind: judgement.kind,
      reason: action.reason,
    });
    const root = finding.githubCommentId;
    const threadId = root === undefined ? undefined : deps.threadId(root);
    if (action.status === "fixed") {
      fixes.push({
        findingId: finding.id,
        fingerprint: finding.fingerprint,
        path: finding.path,
        commentId: reply.commentId,
        author: reply.author,
        ...(root === undefined ? {} : { threadRootId: root }),
        ...(threadId === undefined ? {} : { threadId }),
      });
      result.judged.push(reply.replyId);
      continue;
    }
    let changed = false;
    if (action.status !== undefined) {
      changed = await deps.close(finding.id, action.status, {
        login: reply.author,
        commentId: reply.commentId,
      });
      if (changed) result.closed += 1;
    }
    const resolve = changed && action.resolveThread && threadId !== undefined;
    const reply_ = root === undefined ? undefined : action.reply;
    const learning = changed ? action.learning : undefined;
    if (resolve || reply_ !== undefined || learning !== undefined) {
      result.writes.push({
        findingId: finding.id,
        ...(root === undefined ? {} : { threadRootId: root }),
        ...(resolve ? { threadId } : {}),
        ...(reply_ === undefined
          ? {}
          : { reply: reply_, replyEvent: action.replyEvent ?? "replied" }),
        commentId: reply.commentId,
        ...(learning === undefined ? {} : { learning }),
        author: reply.author,
      });
    }
    result.judged.push(reply.replyId);
  }
  return { writes: result, fixes };
}

/**
 * Settles the fixes the judge saw against the run's own review, which read the file at head
 * without our comment on it (`PrepareOptions.hiddenThreads`): the reviewer wins over the judge.
 * A fix is closed (and its thread resolved) only when a batch of this run reviewed the file and
 * none of its findings was matched to this one. Otherwise it stays open, with one reply.
 * Returns the IDs of the findings it closed; their writes are added to `writes`.
 */
export async function confirmFixes(
  fixes: readonly FixCandidate[],
  review: { reraised: readonly string[]; reviewedNow: readonly string[] },
  writes: ReplyWrites,
  close: SettleDeps["close"],
): Promise<string[]> {
  const reraised = new Set(review.reraised);
  const reviewed = new Set(review.reviewedNow);
  const closed: string[] = [];
  for (const fix of fixes) {
    const base = {
      findingId: fix.findingId,
      commentId: fix.commentId,
      author: fix.author,
      ...(fix.threadRootId === undefined ? {} : { threadRootId: fix.threadRootId }),
    };
    if (reraised.has(fix.fingerprint)) {
      writes.writes.push({
        ...base,
        reply: `The review of this commit found this again in ${inline(fix.path)}, so it still counts.`,
        replyEvent: "replied",
      });
      continue;
    }
    if (!reviewed.has(fix.path)) {
      writes.writes.push({
        ...base,
        reply: `${inline(fix.path)} wasn't reviewed again in this run, so this still counts. It's checked when the file next changes, or someone with write access can resolve this thread.`,
        replyEvent: "replied",
      });
      continue;
    }
    if (await close(fix.findingId, "fixed", { login: fix.author, commentId: fix.commentId })) {
      closed.push(fix.findingId);
      writes.closed += 1;
      if (fix.threadId !== undefined) writes.writes.push({ ...base, threadId: fix.threadId });
    }
  }
  return closed;
}

export interface WriteDeps {
  reply(threadRootId: number, body: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  recordReply(
    findingId: string,
    type: "replied" | "dispute_answered",
    commentId: number,
  ): Promise<void>;
  proposeLearning?(write: ReplyWrites["writes"][number]): Promise<void>;
  replies: Pick<ReplyStore, "finish" | "failed">;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** Writes what `settleReplies` decided on GitHub, and marks the replies. */
export async function writeReplies(writes: ReplyWrites, deps: WriteDeps): Promise<number> {
  let replied = 0;
  for (const write of writes.writes) {
    if (write.threadId !== undefined) {
      try {
        await deps.resolveThread(write.threadId);
      } catch (error) {
        // The finding is closed either way; the thread just stays open on GitHub.
        deps.log("review thread not resolved", {
          findingId: write.findingId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (write.reply !== undefined && write.threadRootId !== undefined) {
      // To the thread's first comment: GitHub has no replies to replies.
      await deps.reply(write.threadRootId, `${write.reply}\n\n${JUDGE_REPLY_MARKER}`);
      await deps.recordReply(write.findingId, write.replyEvent ?? "replied", write.commentId);
      replied += 1;
    }
    if (write.learning !== undefined && deps.proposeLearning !== undefined) {
      try {
        await deps.proposeLearning(write);
      } catch (error) {
        deps.log("learning not proposed", {
          findingId: write.findingId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  await deps.replies.finish(writes.judged, "judged");
  await deps.replies.finish(writes.skipped, "skipped");
  await deps.replies.failed(writes.failed);
  return replied;
}
