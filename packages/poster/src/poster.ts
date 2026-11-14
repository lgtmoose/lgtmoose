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
  /**
   * The markers starting with `markerPrefix` (see `reviewMarkerComment`) in our reviews on
   * `commitId`, from any run, each with its review's state (APPROVED, CHANGES_REQUESTED,
   * COMMENTED, DISMISSED). Always none in shadow mode, where reviews are recorded, not posted.
   */
  markersAt(pull: PullRef, commitId: string, markerPrefix: string): Promise<MarkedReview[]>;
  /**
   * Our App's check runs on the head that carry an external ID (see
   * `CheckRunInput.externalId`), with how many annotations each has. Always none in shadow
   * mode.
   */
  checkRunsOn(pull: PullRef, headSha: string): Promise<OurCheckRun[]>;
}

function rateLimited(error: unknown): boolean {
  return error instanceof GitHubError && error.rateLimited;
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

/** One of our check runs on a commit, by its external ID. */
export interface OurCheckRun {
  externalId: string;
  /** How many annotations it has: GitHub's `annotations_count`. */
  annotations: number;
}

/** A check run as the check-runs endpoint lists it. */
interface ListedCheckRun {
  id: number;
  external_id?: string | null;
  /** The App that created it. */
  app?: { id?: number } | null;
  output?: { annotations_count?: number } | null;
}

export interface GitHubPosterOptions {
  /**
   * The App's ID and slug. A comment or review found by its marker must be the App's own:
   * anyone can quote a marker. Comments carry the App's ID; reviews only its bot user,
   * `<slug>[bot]`.
   */
  appId?: number;
  /** Asked only when a review is looked up, so steps that never do skip the request. */
  appSlug?: () => Promise<string>;
}

/** A marker found in one of our reviews, and that review's state. */
export interface MarkedReview {
  marker: string;
  state: string;
}

/** A review as the reviews endpoint lists it. */
interface ListedReview {
  state?: string | null;
  body?: string | null;
  commit_id?: string | null;
  user?: { login?: string; type?: string } | null;
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

  async markersAt(pull: PullRef, commitId: string, markerPrefix: string): Promise<MarkedReview[]> {
    // The opening of a marker comment with this prefix (the prefix must be a marker's start).
    const opening = reviewMarkerComment(markerPrefix).replace(/ -->$/, "");
    // The App's bot (or, without its slug, any bot): anyone can quote a marker.
    const bot =
      this.options.appSlug === undefined ? undefined : `${await this.options.appSlug()}[bot]`;
    const reviews = await this.github.list<ListedReview>(
      `${repoPath(pull)}/pulls/${pull.pull}/reviews`,
    );
    const markers: MarkedReview[] = [];
    for (const review of reviews) {
      if (review.commit_id !== commitId || review.user?.type !== "Bot") continue;
      if (bot !== undefined && review.user.login !== bot) continue;
      const body = review.body ?? "";
      for (let at = body.indexOf(opening); at >= 0; at = body.indexOf(opening, at + 1)) {
        const end = body.indexOf(" -->", at);
        if (end > at) {
          markers.push({ marker: body.slice(at + "<!-- ".length, end), state: review.state ?? "" });
        }
      }
    }
    return markers;
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
   * order. The original line and side are the posted commit's, which is what the payload gave;
   * the current ones are GitHub's move of them to the PR's head (none once outdated), used only
   * when there's no original. The review is already posted: if they can't be read, they're left
   * undefined.
   */
  private async commentIds(path: string, payload: ReviewPayload): Promise<(number | undefined)[]> {
    if (payload.comments.length === 0) return [];
    let listed: {
      id: number;
      path: string;
      side?: string | null;
      line?: number | null;
      original_side?: string | null;
      original_line?: number | null;
    }[];
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
          (item.original_side ?? item.side ?? "RIGHT") === comment.side &&
          (item.original_line ?? item.line) === comment.line,
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

  async checkRunsOn(pull: PullRef, headSha: string): Promise<OurCheckRun[]> {
    return (await this.checkRuns(pull, headSha)).flatMap((run) =>
      typeof run.external_id === "string"
        ? [{ externalId: run.external_id, annotations: run.output?.annotations_count ?? 0 }]
        : [],
    );
  }

  /** Our check run on the head with this external ID, if there is one. */
  private async findCheckRun(
    pull: PullRef,
    headSha: string,
    externalId: string,
  ): Promise<ListedCheckRun | undefined> {
    return (await this.checkRuns(pull, headSha)).find((run) => run.external_id === externalId);
  }

  /**
   * Our check runs on the head, every one of them. Only our App's: a workflow in the PR can
   * create a check run with our name and any external ID (its token has `checks: write`), so
   * neither says the run is ours. Without the App's ID (tests, local runs) the name decides.
   */
  private async checkRuns(pull: PullRef, headSha: string): Promise<ListedCheckRun[]> {
    // `filter=all`: by default GitHub lists only the latest run of each name.
    const name = encodeURIComponent(CHECK_NAME);
    const runs = await this.github.list<ListedCheckRun>(
      `${repoPath(pull)}/commits/${headSha}/check-runs?check_name=${name}&filter=all`,
      (page) => (page as { check_runs?: ListedCheckRun[] }).check_runs ?? [],
    );
    const { appId } = this.options;
    return appId === undefined ? runs : runs.filter((run) => run.app?.id === appId);
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
        // Deleted by someone (404), or not ours to edit (a 403 that isn't a rate limit): post
        // a new one, and the caller stores the new ID.
        const gone = isStatus(error, 404) || (isStatus(error, 403) && !rateLimited(error));
        if (!gone) throw error;
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
