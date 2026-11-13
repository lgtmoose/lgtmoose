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
