import { FEEDBACK_REPORT_KEY } from "@lgtmoose/config";
import {
  DEFAULT_ACCEPTANCE_THRESHOLD,
  DEFAULT_MIN_SAMPLES,
  FEEDBACK_WINDOW_DAYS,
  MAX_DECLINED_LISTED,
  acceptanceByCategory,
  currentReactions,
  type CategoryStatusCount,
  type DeclinedFinding,
  type FeedbackReport,
} from "@lgtmoose/core";

/**
 * Feedback signals (NIC-841), run by the reconciler on its schedule. GitHub sends no webhook for
 * reactions on review comments, so they're read with REST: a few comments per run, least
 * recently checked first, only on findings raised in the last `READ_WINDOW_DAYS`. The counts
 * are signals only; nothing here changes a finding, a decision or a rule.
 */

/** Reactions are read only on our comments on findings this recent: open or lately closed PRs. */
export const READ_WINDOW_DAYS = 30;
export const DEFAULT_MAX_FEEDBACK_COMMENTS = 100;

/** One of our inline comments to read the reactions of. */
export interface FeedbackComment {
  findingId: string;
  installationId: number;
  /** owner/name */
  repo: string;
  commentId: number;
}

export interface CommentReaction {
  content: string;
  user: string;
  userIsBot: boolean;
  createdAt: string;
}

export interface FeedbackStore {
  /** Our findings' inline comments raised since `since`, least recently checked first. */
  commentsToRead(since: Date, limit: number): Promise<FeedbackComment[]>;
  /** Replaces the finding's recorded reactions with these, and marks it checked. */
  replaceReactions(findingId: string, reactions: ReadonlyMap<string, "+1" | "-1">): Promise<void>;
  /** Our findings raised since `since`, counted by category, status and reaction balance. */
  categoryCounts(since: Date): Promise<CategoryStatusCount[]>;
  /** Our declined findings raised since `since`, newest first. */
  declinedFindings(since: Date, limit: number): Promise<DeclinedFinding[]>;
}

export interface FeedbackGitHub {
  /** The comment's reactions, or `gone` when the comment no longer exists. */
  reactions(
    installationId: number,
    repo: string,
    commentId: number,
  ): Promise<CommentReaction[] | "gone">;
}

export interface FeedbackDeps {
  store: FeedbackStore;
  github: FeedbackGitHub;
  /** Writes the report to the artifact bucket. */
  putReport(key: string, body: string): Promise<void>;
  log(message: string, fields?: Record<string, unknown>): void;
  now?: () => Date;
  maxComments?: number;
  threshold?: number;
  minSamples?: number;
  /**
   * A comment whose reactions came out against it (more 👎 than 👍): outcome learning (NIC-1081)
   * may make a learning of a repeated pattern. Its failure is counted, never thrown.
   */
  onRejected?(comment: FeedbackComment): Promise<void>;
}

export interface FeedbackCounts {
  feedbackCommentsRead: number;
  /** Categories below the acceptance threshold, protected ones included. */
  categoriesFlagged: number;
  errors: number;
}

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

/** Reads reactions, then writes the acceptance report. Errors are counted and logged, never thrown. */
export async function collectFeedback(deps: FeedbackDeps): Promise<FeedbackCounts> {
  const now = deps.now?.() ?? new Date();
  const counts: FeedbackCounts = { feedbackCommentsRead: 0, categoriesFlagged: 0, errors: 0 };
  const fail = (message: string, error: unknown, fields: Record<string, unknown> = {}) => {
    counts.errors += 1;
    deps.log(message, { ...fields, error: error instanceof Error ? error.message : String(error) });
  };

  let comments: FeedbackComment[] = [];
  try {
    comments = await deps.store.commentsToRead(
      daysAgo(now, READ_WINDOW_DAYS),
      deps.maxComments ?? DEFAULT_MAX_FEEDBACK_COMMENTS,
    );
  } catch (error) {
    fail("feedback: comments not listed", error);
  }
  for (const comment of comments) {
    try {
      const reactions = await deps.github.reactions(
        comment.installationId,
        comment.repo,
        comment.commentId,
      );
      // A deleted comment has no reactions left to count.
      const current = reactions === "gone" ? new Map() : currentReactions(reactions);
      await deps.store.replaceReactions(comment.findingId, current);
      counts.feedbackCommentsRead += 1;
      const net = [...current.values()].reduce(
        (sum, reaction) => sum + (reaction === "+1" ? 1 : -1),
        0,
      );
      if (net < 0 && deps.onRejected !== undefined) {
        try {
          await deps.onRejected(comment);
        } catch (error) {
          fail("feedback: rejection not learned from", error, {
            repo: comment.repo,
            commentId: comment.commentId,
          });
        }
      }
    } catch (error) {
      fail("feedback: reactions not read", error, {
        repo: comment.repo,
        commentId: comment.commentId,
      });
    }
  }

  try {
    const since = daysAgo(now, FEEDBACK_WINDOW_DAYS);
    const threshold = deps.threshold ?? DEFAULT_ACCEPTANCE_THRESHOLD;
    const minSamples = deps.minSamples ?? DEFAULT_MIN_SAMPLES;
    const categories = acceptanceByCategory(await deps.store.categoryCounts(since), {
      threshold,
      minSamples,
    });
    const report: FeedbackReport = {
      version: 1,
      generatedAt: now.toISOString(),
      windowDays: FEEDBACK_WINDOW_DAYS,
      threshold,
      minSamples,
      categories,
      declined: await deps.store.declinedFindings(since, MAX_DECLINED_LISTED),
    };
    await deps.putReport(FEEDBACK_REPORT_KEY, `${JSON.stringify(report, null, 2)}\n`);
    counts.categoriesFlagged = categories.filter((category) => category.flagged).length;
    for (const category of categories.filter((entry) => entry.flagged)) {
      deps.log("feedback: category below the acceptance threshold", {
        category: category.category,
        acceptance: category.acceptance,
        accepted: category.accepted,
        rejected: category.rejected,
        protected: category.protected,
      });
    }
  } catch (error) {
    fail("feedback: report not written", error);
  }
  return counts;
}
