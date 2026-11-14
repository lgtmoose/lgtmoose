import type { LabelClient } from "@lgtmoose/summary";
import {
  ANNOTATIONS_PER_REQUEST,
  CHECK_NAME,
  annotationPages,
  checkOutput,
  type CheckRunInput,
} from "./check-run.js";
import { GitHubError, repoPath, type GitHubClient, type PullRef } from "./github.js";
import { GITHUB_BODY_LIMIT } from "./format.js";
import { reviewMarkerComment, withCommentsInBody, type ReviewPayload } from "./review.js";

/** What posting a review did. */
export interface PostedReview {
  /** The review's ID, or undefined in shadow mode. */
  id: number | undefined;
  /** GitHub refused a comment position, so every inline comment went into the body instead. */
  movedToBody: boolean;
  /** The payload that was posted (after the retry, when there was one). */
  payload: ReviewPayload;
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
  /**
   * Edits the summary comment in place when `commentId` still exists, else creates it. With a
   * `marker`, the body ends with it hidden, and without a `commentId` a comment carrying it is
   * edited instead of creating another.
   */
  upsertSummaryComment(
    pull: PullRef,
    body: string,
    commentId?: number,
    marker?: string,
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

/** A comment as the comments endpoint lists it. */
interface ListedComment {
  id: number;
  body?: string | null;
  user?: { type?: string } | null;
  performed_via_github_app?: { id?: number } | null;
}

/** A check run as the check-runs endpoint lists it. */
interface ListedCheckRun {
  id: number;
  external_id?: string | null;
  output?: { annotations_count?: number } | null;
}

export interface GitHubPosterOptions {
  /**
   * The App's ID. A summary comment found by its marker must be the App's own: anyone can
   * quote a marker, and editing their comment would fail on every run.
   */
  appId?: number;
}

/** Posts to GitHub with an installation token. */
export class GitHubPoster implements Poster {
  constructor(
    private readonly github: GitHubClient,
    private readonly options: GitHubPosterOptions = {},
  ) {}

  /** Whether the App wrote the comment (or, without its ID, a bot did). */
  private ours(comment: ListedComment): boolean {
    if (this.options.appId !== undefined) {
      return comment.performed_via_github_app?.id === this.options.appId;
    }
    return comment.user?.type === "Bot";
  }

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
    try {
      const review = await send(payload);
      return { id: review.id, movedToBody: false, payload };
    } catch (error) {
      // 422 usually means a comment position GitHub won't take (the diff changed, a line
      // outside a hunk). It doesn't say which, so all comments go into the body, once.
      if (!isStatus(error, 422) || payload.comments.length === 0) throw error;
      const retry = withCommentsInBody(payload);
      const review = await send(retry);
      return { id: review.id, movedToBody: true, payload: retry };
    }
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
    const pages = annotationPages(input.annotations);
    let runId = input.existingId;
    let sent = 0;
    if (runId === undefined && input.externalId !== undefined) {
      // Created by an earlier attempt: carry on from the annotations it got in. GitHub
      // counts them, and every page but the last is full, so the count says how many pages.
      const existing = await this.findCheckRun(pull, input.headSha, input.externalId);
      if (existing !== undefined) {
        runId = existing.id;
        sent = Math.ceil((existing.output?.annotations_count ?? 0) / ANNOTATIONS_PER_REQUEST);
        if (sent >= pages.length) return existing.id;
      }
    }
    const fields = {
      status: "completed",
      conclusion: input.conclusion,
      ...(input.detailsUrl === undefined ? {} : { details_url: input.detailsUrl }),
      output: checkOutput(input, pages[sent] ?? []),
    };
    const run =
      runId === undefined
        ? await this.github.request<{ id: number }>("POST", `${repoPath(pull)}/check-runs`, {
            name: CHECK_NAME,
            head_sha: input.headSha,
            ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
            ...fields,
          })
        : await this.github.request<{ id: number }>(
            "PATCH",
            `${repoPath(pull)}/check-runs/${runId}`,
            fields,
          );
    // GitHub appends each update's annotations to the run's, 50 at a time.
    for (const page of pages.slice(sent + 1)) {
      await this.github.request("PATCH", `${repoPath(pull)}/check-runs/${run.id}`, {
        output: checkOutput(input, page),
      });
    }
    return run.id;
  }

  /** Our check run on the head with this external ID, if there is one. */
  private async findCheckRun(
    pull: PullRef,
    headSha: string,
    externalId: string,
  ): Promise<ListedCheckRun | undefined> {
    // `filter=all`: by default GitHub lists only the latest run of each name.
    const name = encodeURIComponent(CHECK_NAME);
    const runs = await this.github.list<ListedCheckRun>(
      `${repoPath(pull)}/commits/${headSha}/check-runs?check_name=${name}&filter=all`,
      (page) => (page as { check_runs?: ListedCheckRun[] }).check_runs ?? [],
    );
    return runs.find((run) => run.external_id === externalId);
  }

  async upsertSummaryComment(
    pull: PullRef,
    body: string,
    commentId?: number,
    marker?: string,
  ): Promise<SummaryCommentResult> {
    if (marker !== undefined) {
      // Callers leave room for it (`SUMMARY_MARKER_ROOM` in @lgtmoose/summary).
      body = `${body}\n\n${reviewMarkerComment(marker)}`;
      if (body.length > GITHUB_BODY_LIMIT) {
        throw new Error("The summary comment is too long to add its marker.");
      }
    }
    if (commentId === undefined && marker !== undefined) {
      // No stored ID (a first review, or an attempt that didn't get to store it): find the
      // comment by its marker, so a retry edits the one an earlier attempt made.
      const comment = reviewMarkerComment(marker);
      const comments = await this.github.list<ListedComment>(
        `${repoPath(pull)}/issues/${pull.pull}/comments`,
      );
      commentId = comments.find(
        (candidate) => this.ours(candidate) && candidate.body?.includes(comment) === true,
      )?.id;
    }
    if (commentId !== undefined) {
      try {
        await this.github.request("PATCH", `${repoPath(pull)}/issues/comments/${commentId}`, {
          body,
        });
        return { id: commentId, created: false };
      } catch (error) {
        // Deleted by someone (404), or not ours to edit (403): post a new one, and the caller
        // stores the new ID.
        if (!isStatus(error, 403, 404)) throw error;
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
