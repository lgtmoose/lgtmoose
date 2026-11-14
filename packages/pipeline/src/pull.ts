/** One pull request to review. */
export interface PullTarget {
  owner: string;
  repo: string;
  number: number;
}

/** What the dry run reads from GitHub. Tests pass a fake. */
export interface PullReader {
  pull(target: PullTarget): Promise<PullRequest>;
  /** Comments on the PR's conversation and on its diff, oldest first, up to `limit` of each. */
  comments(target: PullTarget, limit: number): Promise<PullComment[]>;
  /**
   * One of the PR's reviews: its state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or
   * PENDING) and the commit it was submitted on. Optional: the dry run doesn't need it.
   */
  review?(target: PullTarget, reviewId: number): Promise<{ state: string; commitId: string }>;
}

export interface PullRequest {
  title: string;
  body: string;
  author: string;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  state: string;
}

export interface PullComment {
  author: string;
  body: string;
  /** Set for comments on the diff. */
  path?: string;
  /** The line on the PR's current diff; undefined when the comment is outdated or general. */
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
}
