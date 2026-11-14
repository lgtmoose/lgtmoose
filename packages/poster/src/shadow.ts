import type { LabelClient } from "@lgtmoose/summary";
import type { CheckRunInput } from "./check-run.js";
import type { PullRef } from "./github.js";
import type { PostedReview, Poster, SummaryCommentResult } from "./poster.js";
import type { ReviewPayload } from "./review.js";

/** Where shadow mode writes. `S3TranscriptStore` from @lgtmoose/harness fits. */
export interface ObjectStore {
  put(key: string, body: string): Promise<void>;
}

/** A log line with fields. Never pass it secrets. */
export type ShadowLog = (message: string, fields: Record<string, unknown>) => void;

export interface ShadowPosterOptions {
  store: ObjectStore;
  /** Keys are `<prefix><owner>/<repo>/<pull>/<runId>/<n>-<what>.json`. */
  runId: string;
  prefix?: string;
  log?: ShadowLog;
  /**
   * Reads the PR's real labels, so a label sync in shadow mode starts from what's there. Writes
   * are recorded, never sent. Without it, the repository and PR have no labels.
   */
  labelReader?: Pick<LabelClient, "listRepoLabels" | "listPrLabels">;
}

/**
 * Shadow mode: records everything a run would post, to the object store and the log, and posts
 * nothing to GitHub. Each call writes one JSON object, numbered in call order.
 */
export class ShadowPoster implements Poster {
  private sequence = 0;

  constructor(private readonly options: ShadowPosterOptions) {}

  private async record(pull: PullRef, what: string, data: Record<string, unknown>): Promise<void> {
    this.sequence += 1;
    const key = `${this.options.prefix ?? "shadow/"}${pull.owner}/${pull.repo}/${pull.pull}/${this.options.runId}/${String(this.sequence).padStart(3, "0")}-${what}.json`;
    await this.options.store.put(key, `${JSON.stringify({ what, pull, ...data }, null, 2)}\n`);
    this.options.log?.(`shadow: ${what}`, { key, pull: `${pull.owner}/${pull.repo}#${pull.pull}` });
  }

  async submitReview(
    pull: PullRef,
    commitId: string,
    payload: ReviewPayload,
  ): Promise<PostedReview> {
    await this.record(pull, "review", {
      commit_id: commitId,
      event: payload.event,
      body: payload.body,
      comments: payload.comments,
      nits_left_out: payload.nitsLeftOut,
    });
    return { id: undefined, movedToBody: false, payload };
  }

  async startCheckRun(pull: PullRef, headSha: string): Promise<undefined> {
    await this.record(pull, "check-run-start", { head_sha: headSha });
    return undefined;
  }

  async completeCheckRun(pull: PullRef, input: CheckRunInput): Promise<undefined> {
    await this.record(pull, "check-run", {
      head_sha: input.headSha,
      conclusion: input.conclusion,
      title: input.title,
      summary: input.summary,
      annotations: input.annotations,
    });
    return undefined;
  }

  async upsertSummaryComment(
    pull: PullRef,
    body: string,
    commentId?: number,
    marker?: string,
  ): Promise<SummaryCommentResult> {
    await this.record(pull, "summary-comment", {
      comment_id: commentId ?? null,
      body,
      ...(marker === undefined ? {} : { marker }),
    });
    return { id: commentId, created: commentId === undefined };
  }

  async reviewedAt(_pull: PullRef, _commitId: string, _markerPrefix: string): Promise<boolean> {
    return false;
  }

  labels(pull: PullRef): LabelClient {
    const reader = this.options.labelReader;
    let current: string[] | undefined;
    const prLabels = async () => {
      current ??= reader === undefined ? [] : await reader.listPrLabels();
      return current;
    };
    return {
      listRepoLabels: async () => (reader === undefined ? [] : reader.listRepoLabels()),
      listPrLabels: async () => [...(await prLabels())],
      addPrLabels: async (labels) => {
        const now = await prLabels();
        current = [...now, ...labels.filter((label) => !now.includes(label))];
        await this.record(pull, "labels-add", { labels });
      },
      removePrLabel: async (label) => {
        current = (await prLabels()).filter((name) => name !== label);
        await this.record(pull, "labels-remove", { label });
      },
    };
  }
}
