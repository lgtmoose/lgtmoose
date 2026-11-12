/**
 * Turns a verified GitHub webhook delivery into the small job the dispatcher consumes. Pure: the
 * gateway does the I/O (signature, queue), this decides what the delivery means.
 *
 * Payloads are typed `unknown` on purpose. They arrive as JSON from the network, so every field
 * is checked before use rather than trusted to match a TypeScript type.
 */

export const REVIEW_JOB_KINDS = [
  "pr_opened",
  "pr_updated",
  "pr_ready",
  "pr_closed",
  "comment",
  "review",
  "review_comment",
  "thread_resolved",
  "thread_unresolved",
] as const;

export type ReviewJobKind = (typeof REVIEW_JOB_KINDS)[number];

/**
 * One unit of work for the dispatcher. Only what it needs to find the PR and decide what to do;
 * it fetches anything else from GitHub itself, so a stale or oversized payload never travels.
 */
export interface ReviewJob {
  kind: ReviewJobKind;
  /** X-GitHub-Delivery. The dispatcher dedupes on this against the database. */
  deliveryId: string;
  installationId: number;
  /** "owner/name", as GitHub spells it. */
  repo: string;
  prNumber: number;
  /** The PR head at the time of the event, when the payload carries the PR. */
  headSha?: string;
  /** Login of the user who caused the event. */
  actor: string;
  /** The issue comment or review comment that triggered the job. */
  commentId?: number;
  /** The submitted review that triggered the job. */
  reviewId?: number;
  /** GraphQL node ID of a resolved or unresolved review thread (threads have no REST id). */
  threadNodeId?: string;
  /** ISO 8601 time the gateway received the delivery. */
  receivedAt: string;
}

export interface Ignored {
  ignored: string;
}

export interface ToReviewJobOptions {
  deliveryId: string;
  /** GitHub orgs or users whose repositories may be reviewed. Compared case-insensitively. */
  allowedOrgs: readonly string[];
  receivedAt: Date;
}

/** A PR carrying this label is never reviewed. */
export const SKIP_LABEL = "skip-lgtmoose";

/** Which actions of which events become jobs, and as what kind. */
const KINDS: Record<string, Record<string, ReviewJobKind>> = {
  pull_request: {
    opened: "pr_opened",
    // A reopened PR may have moved on since it closed; treat it as new.
    reopened: "pr_opened",
    synchronize: "pr_updated",
    ready_for_review: "pr_ready",
    // Closed PRs become jobs so the dispatcher can cancel runs and clean up.
    closed: "pr_closed",
  },
  issue_comment: { created: "comment" },
  pull_request_review: { submitted: "review" },
  pull_request_review_comment: { created: "review_comment" },
  pull_request_review_thread: { resolved: "thread_resolved", unresolved: "thread_unresolved" },
};

export function isReviewJobKind(value: unknown): value is ReviewJobKind {
  return typeof value === "string" && (REVIEW_JOB_KINDS as readonly string[]).includes(value);
}

/** FIFO message group: jobs for one PR are handled in order, different PRs in parallel. */
export function reviewJobGroupId(job: Pick<ReviewJob, "repo" | "prNumber">): string {
  return `${job.repo}#${job.prNumber}`;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    const name = str(record(label)?.name);
    return name === undefined ? [] : [name];
  });
}

/**
 * Bots include our own App, so this also stops LGTMoose reacting to its own comments and
 * reviews. GitHub sets `type: "Bot"` for Apps; the `[bot]` suffix catches payloads that don't.
 */
function isBot(sender: Json): boolean {
  return sender.type === "Bot" || (str(sender.login)?.endsWith("[bot]") ?? false);
}

/** The PR the event is about. issue_comment carries it as an issue with a `pull_request` key. */
function pullRequestOf(event: string, payload: Json): Json | undefined {
  if (event !== "issue_comment") return record(payload.pull_request);
  const issue = record(payload.issue);
  return issue !== undefined && record(issue.pull_request) !== undefined ? issue : undefined;
}

/** The comment, review or thread that triggered the job, under the field the dispatcher reads. */
function trigger(
  kind: ReviewJobKind,
  payload: Json,
): Pick<ReviewJob, "commentId" | "reviewId" | "threadNodeId"> {
  switch (kind) {
    case "comment":
    case "review_comment": {
      const id = positiveInt(record(payload.comment)?.id);
      return id === undefined ? {} : { commentId: id };
    }
    case "review": {
      const id = positiveInt(record(payload.review)?.id);
      return id === undefined ? {} : { reviewId: id };
    }
    case "thread_resolved":
    case "thread_unresolved": {
      const id = str(record(payload.thread)?.node_id);
      return id === undefined ? {} : { threadNodeId: id };
    }
    default:
      return {};
  }
}

/**
 * Maps a delivery to a job, or says why it's ignored. The reason goes back to GitHub in the
 * response body, so it shows on the App's "Recent Deliveries" page when someone asks why a PR
 * wasn't reviewed.
 *
 * Closing is exempt from the draft, bot and skip-label rules: a merge bot closing a PR, or a PR
 * labelled after it was reviewed, still needs its runs cancelled and its state cleaned up.
 */
export function toReviewJob(
  event: string,
  payload: unknown,
  options: ToReviewJobOptions,
): ReviewJob | Ignored {
  const body = record(payload);
  if (body === undefined) return { ignored: "payload is not an object" };

  const action = str(body.action);
  const kinds = KINDS[event];
  if (kinds === undefined) return { ignored: `unsupported event: ${event}` };
  const kind = action === undefined ? undefined : kinds[action];
  if (kind === undefined) return { ignored: `unsupported action: ${event}.${action ?? "none"}` };

  const pr = pullRequestOf(event, body);
  if (pr === undefined) return { ignored: "not a pull request" };

  const repository = record(body.repository);
  const repo = str(repository?.full_name);
  const owner = str(record(repository?.owner)?.login);
  const installationId = positiveInt(record(body.installation)?.id);
  const prNumber = positiveInt(pr.number);
  const sender = record(body.sender);
  const actor = str(sender?.login);
  if (
    repo === undefined ||
    owner === undefined ||
    installationId === undefined ||
    prNumber === undefined ||
    sender === undefined ||
    actor === undefined
  ) {
    return { ignored: "payload is missing the repository, installation, PR or sender" };
  }

  const allowed = options.allowedOrgs.some((org) => org.toLowerCase() === owner.toLowerCase());
  if (!allowed) return { ignored: `owner not allowed: ${owner}` };

  if (kind !== "pr_closed") {
    if (isBot(sender)) return { ignored: `bot sender: ${actor}` };
    // ready_for_review arrives with draft already false, so it passes this check by itself.
    if (pr.draft === true) return { ignored: "draft pull request" };
    if (labelNames(pr.labels).includes(SKIP_LABEL)) return { ignored: `labelled ${SKIP_LABEL}` };
  }

  const headSha = str(record(pr.head)?.sha);
  return {
    kind,
    deliveryId: options.deliveryId,
    installationId,
    repo,
    prNumber,
    ...(headSha === undefined ? {} : { headSha }),
    actor,
    ...trigger(kind, body),
    receivedAt: options.receivedAt.toISOString(),
  };
}
