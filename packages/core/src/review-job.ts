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
  "pr_labeled",
  "pr_checks",
  "comment",
  "review",
  "review_comment",
  "thread_resolved",
  "thread_unresolved",
] as const;

export type ReviewJobKind = (typeof REVIEW_JOB_KINDS)[number];

/**
 * Why a run was asked for rather than started by a push: a person's `review` or `full review`
 * command (the latest commit, or the whole PR again), or `replies`, which the conversation
 * handler queues when a person replies on one of our findings' threads, so the reply judge
 * runs without waiting for a push, or `explain`, which it queues when a person asks
 * `@lgtmoose explain` on a finding, so the explainer answers with a model.
 */
export const REVIEW_REQUESTS = ["review", "full_review", "replies", "explain"] as const;

export type ReviewRequest = (typeof REVIEW_REQUESTS)[number];

/**
 * One unit of work for the dispatcher. Only what it needs to find the PR and decide what to do;
 * it fetches anything else from GitHub itself, so a stale or oversized payload never travels.
 */
export interface ReviewJob {
  kind: ReviewJobKind;
  /**
   * X-GitHub-Delivery. The queue dedupes on it for five minutes; after that the dispatcher's
   * execution names (per head, plus this ID for a retry) catch redeliveries.
   */
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
  /** For `pr_labeled`: the label that was added. Whether it starts a review is the repo's call. */
  label?: string;
  /**
   * The actor is a bot. Bots' events are ignored, except a label added or a comment that may
   * ask for a review, which a repo may trust from the bots it lists (`review.trusted_bots`,
   * NIC-1077). Whoever acts on the job checks that list; nothing else a bot does counts.
   */
  botActor?: true;
  /**
   * Set when a person asked for this review with an `@lgtmoose review` or `full review`
   * command, never by the gateway. A requested review isn't debounced and runs on a paused PR;
   * a full one also leaves earlier reviews out, so the whole PR is reviewed again. `replies`
   * is queued for replies waiting for the reply judge, and doesn't run on a paused PR.
   */
  requested?: ReviewRequest;
  /** ISO 8601 time the gateway received the delivery. */
  receivedAt: string;
  /**
   * The PR's `updated_at` from the payload: when GitHub says the event happened, in whole
   * seconds. Deliveries can arrive out of order, so the dispatcher orders a PR's jobs by this.
   */
  eventAt?: string;
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
    // A label may be the repo's review trigger (`review.trigger: label`).
    labeled: "pr_labeled",
    // Closed PRs become jobs so the dispatcher can cancel runs and clean up.
    closed: "pr_closed",
  },
  issue_comment: { created: "comment" },
  pull_request_review: { submitted: "review" },
  pull_request_review_comment: { created: "review_comment" },
  pull_request_review_thread: { resolved: "thread_resolved", unresolved: "thread_unresolved" },
  // A check finishing may be what a PR's review waits for (`review.wait_for_checks`, NIC-1078).
  // The dispatcher drops it unless the PR waits on that head, so it costs nothing elsewhere.
  check_suite: { completed: "pr_checks" },
  check_run: { completed: "pr_checks" },
};

/**
 * LGTMoose's own check run (`CHECK_NAME` in @lgtmoose/poster). Its finishing is never what a
 * review waits for, so it makes no job.
 */
const OWN_CHECK_NAME = "LGTMoose";

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

/** A timestamp from the payload as ISO 8601, or undefined when it isn't one. */
function isoTime(value: unknown): string | undefined {
  const text = str(value);
  const time = text === undefined ? Number.NaN : Date.parse(text);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
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

/**
 * A bot's comment that may be a trusted agent's `@lgtmoose review` (NIC-1077): a line that starts
 * with an `@`-mention followed by `review`. Other bot comments are ignored here, so CI bots'
 * chatter never reaches the queue. The conversation handler checks the repo's trusted bots.
 */
const BOT_REVIEW_REQUEST = /^[ \t]*@[A-Za-z0-9-]+[ \t]+review\b/im;

/** Whether a bot's event may be a trusted agent's review trigger (see `ReviewJob.botActor`). */
function botTrigger(kind: ReviewJobKind, payload: Json): boolean {
  // CI runs as a bot: a check finishing is a fact about the head, nobody asking for anything.
  if (kind === "pr_labeled" || kind === "pr_checks") return true;
  if (kind !== "comment") return false;
  return BOT_REVIEW_REQUEST.test(str(record(payload.comment)?.body) ?? "");
}

/**
 * The PR a finished check suite or check run is about: the first of its `pull_requests` whose
 * head is the commit it checked. GitHub leaves the list empty for a fork's PR; the reconciler
 * catches those. Shaped like a PR payload (its number and head), the rest left out.
 */
function checkedPullRequest(event: string, payload: Json): Json | undefined {
  const check = record(event === "check_suite" ? payload.check_suite : payload.check_run);
  if (check === undefined) return undefined;
  if (event === "check_run" && str(check.name) === OWN_CHECK_NAME) return undefined;
  const sha = str(check.head_sha);
  if (sha === undefined) return undefined;
  const pulls = Array.isArray(check.pull_requests) ? check.pull_requests : [];
  for (const candidate of pulls) {
    const pull = record(candidate);
    if (pull !== undefined && str(record(pull.head)?.sha) === sha) {
      const at = isoTime(check.completed_at) ?? isoTime(check.updated_at);
      return {
        number: pull.number,
        head: { sha },
        ...(at === undefined ? {} : { updated_at: at }),
      };
    }
  }
  return undefined;
}

/** The PR the event is about. issue_comment carries it as an issue with a `pull_request` key. */
function pullRequestOf(event: string, payload: Json): Json | undefined {
  if (event === "check_suite" || event === "check_run") return checkedPullRequest(event, payload);
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
      // The thread's first comment is the one a finding records (`github_comment_id`), so the
      // dispatcher can follow the thread without asking GitHub.
      const thread = record(payload.thread);
      const id = str(thread?.node_id);
      const first = Array.isArray(thread?.comments) ? record(thread.comments[0]) : undefined;
      const commentId = positiveInt(first?.id);
      return {
        ...(id === undefined ? {} : { threadNodeId: id }),
        ...(commentId === undefined ? {} : { commentId }),
      };
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
  // Own-property lookups only: `event` comes from a header and `action` from the payload, and
  // plain indexing would resolve names like "constructor" or "__proto__" to inherited values.
  const kinds = Object.hasOwn(KINDS, event) ? KINDS[event] : undefined;
  if (kinds === undefined) return { ignored: `unsupported event: ${event}` };
  const kind = action !== undefined && Object.hasOwn(kinds, action) ? kinds[action] : undefined;
  if (!isReviewJobKind(kind)) {
    return { ignored: `unsupported action: ${event}.${action ?? "none"}` };
  }

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

  const bot = isBot(sender);
  if (kind !== "pr_closed") {
    if (bot && !botTrigger(kind, body)) return { ignored: `bot sender: ${actor}` };
    // ready_for_review arrives with draft already false, so it passes this check by itself.
    if (pr.draft === true) return { ignored: "draft pull request" };
    if (labelNames(pr.labels).includes(SKIP_LABEL)) return { ignored: `labelled ${SKIP_LABEL}` };
  }

  // A submitted review matters only for the `@lgtmoose` commands in its body: an approval or
  // a "changes requested" with no text has nothing to read.
  if (kind === "review" && (str(record(body.review)?.body)?.trim() ?? "") === "") {
    return { ignored: "review has no body" };
  }

  const label = kind === "pr_labeled" ? str(record(body.label)?.name) : undefined;
  if (kind === "pr_labeled" && label === undefined) return { ignored: "labeled without a label" };

  const headSha = str(record(pr.head)?.sha);
  const eventAt = isoTime(pr.updated_at);
  return {
    kind,
    deliveryId: options.deliveryId,
    installationId,
    repo,
    prNumber,
    ...(headSha === undefined ? {} : { headSha }),
    actor,
    ...trigger(kind, body),
    ...(label === undefined ? {} : { label }),
    ...(bot && kind !== "pr_closed" && kind !== "pr_checks" ? { botActor: true as const } : {}),
    receivedAt: options.receivedAt.toISOString(),
    ...(eventAt === undefined ? {} : { eventAt }),
  };
}
