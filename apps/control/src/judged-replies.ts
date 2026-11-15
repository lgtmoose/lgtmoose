import type { Judgement } from "@lgtmoose/core";
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
 * 1. `settleReplies`, before the decision: each judgement is decided, the findings it closes are
 *    closed in the database (so the decision counts them closed), and what to write on GitHub is
 *    saved once to the run's `replies.json`. A retried attempt reads that file back rather than
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
  findings: readonly (RepliedFinding & { id: string; githubCommentId: number | undefined })[];
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

/** Decides each judged reply and closes the findings that allows. Database only, no GitHub. */
export async function settleReplies(
  judged: readonly JudgedReply[],
  deps: SettleDeps,
): Promise<ReplyWrites> {
  const result: ReplyWrites = {
    version: 1,
    judged: [],
    failed: [],
    skipped: [],
    writes: [],
    closed: 0,
  };
  if (judged.length === 0) return result;
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
    let changed = false;
    if (action.status !== undefined) {
      changed = await deps.close(finding.id, action.status, {
        login: reply.author,
        commentId: reply.commentId,
      });
      if (changed) result.closed += 1;
    }
    const root = finding.githubCommentId;
    const threadId = root === undefined ? undefined : deps.threadId(root);
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
  return result;
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
