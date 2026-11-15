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
  /**
   * A file's text at a commit (the contents API); undefined when there's no such file. For the
   * repo config at the base before anything is cloned (`review.trigger`). Optional: without it,
   * every run reviews.
   */
  fileAt?(target: PullTarget, sha: string, path: string): Promise<string | undefined>;
  /**
   * The checks on a commit, for `review.wait_for_checks` (NIC-1078): each check run's latest
   * attempt and each commit status's latest state. Optional: without it, no run waits for CI.
   */
  checksAt?(target: PullTarget, sha: string): Promise<HeadChecks>;
  /**
   * The names of the status checks a branch requires to merge: from its rulesets (the rules API)
   * and its classic branch protection, as far as they can be read without `administration`.
   */
  requiredChecks?(target: PullTarget, branch: string): Promise<string[]>;
}

/** A commit's CI as `checksAt` reads it. */
export interface HeadChecks {
  /** Check runs, the latest attempt of each name. */
  runs: readonly {
    name: string;
    /** queued, in_progress, completed, waiting, requested or pending. */
    status: string;
    /** When completed: success, failure, neutral, cancelled, skipped, timed_out, action_required or stale. */
    conclusion: string | undefined;
  }[];
  /** Commit statuses, the latest of each context: success, pending, failure or error. */
  statuses: readonly { context: string; state: string }[];
}

export interface PullRequest {
  title: string;
  body: string;
  author: string;
  /** The author's relationship to the repository (`author_association`), when GitHub gave it. */
  association?: string;
  /**
   * Whether the repository is private (`base.repo.private`), when GitHub gave it. Unknown is
   * treated as public wherever it matters, such as how much of a linked ticket the summary shows.
   */
  repoPrivate?: boolean;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  state: string;
  /** The PR's label names as GitHub has them now, when it gave them. */
  labels?: string[];
  /** Whether the PR is a draft, when GitHub said. */
  draft?: boolean;
}

export interface PullComment {
  /** GitHub's ID for the comment (a review comment's for comments on the diff). */
  id?: number;
  author: string;
  body: string;
  /** Set for comments on the diff. */
  path?: string;
  /** The line on the PR's current diff; undefined when the comment is outdated or general. */
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  /** Whether a bot (an App) or a person wrote it, as GitHub says. */
  authorType?: "bot" | "human";
  /**
   * The author's relationship to the repository, as GitHub reports it on the comment
   * (`author_association`: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE…).
   */
  association?: string;
  /** For a reply on the diff: the ID of the comment it replies to (its thread's first one). */
  inReplyTo?: number;
  /** The GitHub App that posted it, when one did (`performed_via_github_app.id`). */
  viaAppId?: number;
  /** Its page on GitHub. */
  url?: string;
}
