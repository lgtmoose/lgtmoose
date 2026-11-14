import type { LabelClient } from "@lgtmoose/summary";
import { CHECK_NAME, annotationPages, checkOutput, type CheckRunInput } from "./check-run.js";
import { GitHubError, repoPath, type GitHubClient, type PullRef } from "./github.js";
import { withCommentsInBody, type ReviewPayload } from "./review.js";

/** What posting a review did. */
export interface PostedReview {
  /** The review's ID, or undefined in shadow mode. */
  id: number | undefined;
  /** GitHub refused a comment position, so every inline comment went into the body instead. */
  movedToBody: boolean;
  /** The payload that was posted (after the retry, when there was one). */
  payload: ReviewPayload;
  /**
   * Each of `payload.comments`' review-comment ID on GitHub, in the same order; undefined where
   * it couldn't be read (and always in shadow mode). Used to follow the comment's thread.
   */
  commentIds: (number | undefined)[];
}

export interface SummaryCommentResult {
  /** The comment's ID: store it to edit the comment next time. Undefined in shadow mode. */
  id: number | undefined;
  created: boolean;
}

/**
 * Everything a review run posts. `GitHubPoster` posts to GitHub; `ShadowPoster` records the
 * same calls to an object store and the log, for shadow mode.
 */
export interface Poster {
  /** Submits the run's one review on `commitId`. */
  submitReview(pull: PullRef, commitId: string, payload: ReviewPayload): Promise<PostedReview>;
  /** Starts the check run (in progress) and returns its ID, to complete with `completeCheckRun`. */
  startCheckRun(pull: PullRef, headSha: string): Promise<number | undefined>;
  /** Completes (or creates, without `existingId`) the check run with its conclusion and annotations. */
  completeCheckRun(pull: PullRef, input: CheckRunInput): Promise<number | undefined>;
  /** Edits the summary comment in place when `commentId` still exists, else creates it. */
  upsertSummaryComment(
    pull: PullRef,
    body: string,
    commentId?: number,
  ): Promise<SummaryCommentResult>;
  /** Status label calls for this PR, for `syncStatusLabel`. */
  labels(pull: PullRef): LabelClient;
}

function isStatus(error: unknown, ...statuses: number[]): boolean {
  return error instanceof GitHubError && statuses.includes(error.status);
}

/** The label calls against GitHub. Labels are never created; removing a missing one is fine. */
export class GitHubLabelClient implements LabelClient {
  constructor(
    private readonly github: GitHubClient,
    private readonly pull: PullRef,
  ) {}

  private get issue(): string {
    return `${repoPath(this.pull)}/issues/${this.pull.pull}`;
  }

  async listRepoLabels(): Promise<string[]> {
    const labels = await this.github.list<{ name: string }>(`${repoPath(this.pull)}/labels`);
    return labels.map((label) => label.name);
  }

  async listPrLabels(): Promise<string[]> {
    const labels = await this.github.list<{ name: string }>(`${this.issue}/labels`);
    return labels.map((label) => label.name);
  }

  async addPrLabels(labels: readonly string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.github.request("POST", `${this.issue}/labels`, { labels });
  }

  async removePrLabel(label: string): Promise<void> {
    try {
      await this.github.request("DELETE", `${this.issue}/labels/${encodeURIComponent(label)}`);
    } catch (error) {
      // Already gone (someone removed it meanwhile): the goal is reached.
      if (!isStatus(error, 404)) throw error;
    }
  }
}

/** Posts to GitHub with an installation token. */
export class GitHubPoster implements Poster {
  constructor(private readonly github: GitHubClient) {}

  async submitReview(
    pull: PullRef,
    commitId: string,
    payload: ReviewPayload,
  ): Promise<PostedReview> {
    const path = `${repoPath(pull)}/pulls/${pull.pull}/reviews`;
    const send = (sent: ReviewPayload) =>
      this.github.request<{ id: number }>("POST", path, {
        commit_id: commitId,
        event: sent.event,
        body: sent.body,
        comments: sent.comments,
      });
    let review: { id: number };
    let posted = payload;
    try {
      review = await send(payload);
    } catch (error) {
      // 422 usually means a comment position GitHub won't take (the diff changed, a line
      // outside a hunk). It doesn't say which, so all comments go into the body, once.
      if (!isStatus(error, 422) || payload.comments.length === 0) throw error;
      posted = withCommentsInBody(payload);
      review = await send(posted);
    }
    return {
      id: review.id,
      movedToBody: posted !== payload,
      payload: posted,
      commentIds: await this.commentIds(`${path}/${review.id}/comments`, posted),
    };
  }

  /**
   * The review's comment IDs, matched to the payload's comments by place (path, side, line), in
   * order. The review is already posted: if they can't be read, they're left undefined.
   */
  private async commentIds(path: string, payload: ReviewPayload): Promise<(number | undefined)[]> {
    if (payload.comments.length === 0) return [];
    let listed: { id: number; path: string; side?: string | null; line?: number | null }[];
    try {
      listed = await this.github.list(path);
    } catch {
      return payload.comments.map(() => undefined);
    }
    const used = new Set<number>();
    return payload.comments.map((comment) => {
      const match = listed.find(
        (item) =>
          !used.has(item.id) &&
          item.path === comment.path &&
          (item.side ?? "RIGHT") === comment.side &&
          item.line === comment.line,
      );
      if (match === undefined) return undefined;
      used.add(match.id);
      return match.id;
    });
  }

  async startCheckRun(pull: PullRef, headSha: string): Promise<number> {
    const run = await this.github.request<{ id: number }>("POST", `${repoPath(pull)}/check-runs`, {
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
    });
    return run.id;
  }

  async completeCheckRun(pull: PullRef, input: CheckRunInput): Promise<number> {
    const [first = [], ...rest] = annotationPages(input.annotations);
    const fields = {
      status: "completed",
      conclusion: input.conclusion,
      ...(input.detailsUrl === undefined ? {} : { details_url: input.detailsUrl }),
      output: checkOutput(input, first),
    };
    const run =
      input.existingId === undefined
        ? await this.github.request<{ id: number }>("POST", `${repoPath(pull)}/check-runs`, {
            name: CHECK_NAME,
            head_sha: input.headSha,
            ...fields,
          })
        : await this.github.request<{ id: number }>(
            "PATCH",
            `${repoPath(pull)}/check-runs/${input.existingId}`,
            fields,
          );
    // GitHub appends each update's annotations to the run's, 50 at a time.
    for (const page of rest) {
      await this.github.request("PATCH", `${repoPath(pull)}/check-runs/${run.id}`, {
        output: checkOutput(input, page),
      });
    }
    return run.id;
  }

  async upsertSummaryComment(
    pull: PullRef,
    body: string,
    commentId?: number,
  ): Promise<SummaryCommentResult> {
    if (commentId !== undefined) {
      try {
        await this.github.request("PATCH", `${repoPath(pull)}/issues/comments/${commentId}`, {
          body,
        });
        return { id: commentId, created: false };
      } catch (error) {
        // Deleted by someone: post a new one, and the caller stores the new ID.
        if (!isStatus(error, 404)) throw error;
      }
    }
    const comment = await this.github.request<{ id: number }>(
      "POST",
      `${repoPath(pull)}/issues/${pull.pull}/comments`,
      { body },
    );
    return { id: comment.id, created: true };
  }

  labels(pull: PullRef): LabelClient {
    return new GitHubLabelClient(this.github, pull);
  }
}
