import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * Embedding size for learnings. 1024 fits Amazon Titan Text Embeddings v2 by default and
 * OpenAI text-embedding-3 with `dimensions: 1024`.
 */
export const EMBEDDING_DIMENSIONS = 1024;

// GitHub comment IDs are already above 2^31, so they are stored as bigint. `mode: "number"` is
// safe: JavaScript numbers are exact up to 2^53.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const severity = pgEnum("severity", ["blocking", "should_fix", "nit"]);
export const diffSide = pgEnum("diff_side", ["LEFT", "RIGHT"]);
export const findingSource = pgEnum("finding_source", ["self", "bot", "human"]);
export const findingStatus = pgEnum("finding_status", [
  "open",
  "fixed",
  "declined",
  "disputed",
  "resolved_by_human",
  "outdated",
]);
export const findingEventType = pgEnum("finding_event_type", [
  "raised",
  "replied",
  "fixed",
  "declined",
  "dispute_answered",
  "resolved",
  "outdated",
  // Raised again more severely: the finding now has the higher severity.
  "escalated",
  // A person unresolved the finding's review thread after resolving it: open again.
  "unresolved",
]);
export const runKind = pgEnum("run_kind", ["first", "incremental", "comments", "full"]);
export const runStatus = pgEnum("run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
  // Posted nothing: another run's review already covered its head. Its head counts as
  // reviewed, but it never counts as a newer run that posted.
  "covered",
]);
export const reviewDepth = pgEnum("review_depth", ["full", "move", "mechanical", "skipped"]);
export const learningKind = pgEnum("learning_kind", [
  "accepted_pattern",
  "correction",
  "convention",
  "scoping",
]);
export const learningStatus = pgEnum("learning_status", ["pending", "active", "retired"]);
export const reaction = pgEnum("reaction", ["+1", "-1"]);

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: integer("installation_id").notNull(),
    /** owner/name */
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    author: text("author").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    lastReviewedSha: text("last_reviewed_sha"),
    commentsThrough: timestamp("comments_through", { withTimezone: true }),
    statusLabel: text("status_label"),
    summaryCommentId: bigint("summary_comment_id", { mode: "number" }),
    /**
     * The event of the last review we posted (APPROVE, COMMENT or REQUEST_CHANGES), so a run
     * with nothing new can tell whether the review on GitHub still says the right thing.
     */
    lastReviewEvent: text("last_review_event"),
    /** That review's GitHub ID, to tell whether an approval was dismissed since. */
    lastReviewId: bigint("last_review_id", { mode: "number" }),
    paused: boolean("paused").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pull_requests_repo_number_key").on(t.repo, t.number)],
);

export const reviewRuns = pgTable(
  "review_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    fromSha: text("from_sha"),
    kind: runKind("kind").notNull(),
    status: runStatus("status").notNull().default("queued"),
    executionArn: text("execution_arn"),
    filesTotal: integer("files_total"),
    filesDone: integer("files_done").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    error: text("error"),
    /**
     * When the event the run reviews happened (the dispatcher's job time, the PR's
     * `updated_at`): runs of a PR are ordered by it, not by when their rows were made.
     */
    eventAt: timestamp("event_at", { withTimezone: true }),
    /**
     * Whether the run wrote PR-level state (summary, label, the PR's record): set when it
     * succeeds, and when a covered run writes the PR's outputs. Older runs defer to such a run.
     */
    wrotePr: boolean("wrote_pr").notNull().default(false),
    /**
     * What a run that wrote PR-level state set there: the status label, and the review it posted
     * (event and GitHub ID). The reconciler puts the PR back to these when its head returns to
     * this run's head (a force-push back to a reviewed commit).
     */
    statusLabel: text("status_label"),
    reviewEvent: text("review_event"),
    reviewId: bigint("review_id", { mode: "number" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("review_runs_pull_request_idx").on(t.pullRequestId, t.createdAt)],
);

export const filesReviewed = pgTable(
  "files_reviewed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobSha: text("blob_sha").notNull(),
    /**
     * The version on the base side of the PR's diff (the merge base's), when there is one: a
     * file is only reviewed already when both sides match.
     */
    baseBlobSha: text("base_blob_sha"),
    depth: reviewDepth("depth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("files_reviewed_run_path_key").on(t.runId, t.path)],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => reviewRuns.id, { onDelete: "set null" }),
    fingerprint: text("fingerprint").notNull(),
    ruleCategory: text("rule_category").notNull(),
    severity: severity("severity").notNull(),
    path: text("path"),
    // The file's name on the base side of the PR's diff when the finding was raised: the file an
    // old-side (LEFT) line is in. Followed through the base's renames, never the head's.
    basePath: text("base_path"),
    line: integer("line"),
    startLine: integer("start_line"),
    side: diffSide("side"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    raisedAtSha: text("raised_at_sha").notNull(),
    source: findingSource("source").notNull().default("self"),
    /** Login of the other reviewer, for findings with source bot or human. */
    sourceLogin: text("source_login"),
    status: findingStatus("status").notNull().default("open"),
    githubCommentId: bigint("github_comment_id", { mode: "number" }),
    githubThreadId: text("github_thread_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("findings_pull_request_fingerprint_key").on(t.pullRequestId, t.fingerprint),
    index("findings_open_idx")
      .on(t.pullRequestId)
      .where(sql`${t.status} = 'open'`),
  ],
);

export const findingEvents = pgTable(
  "finding_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    type: findingEventType("type").notNull(),
    actor: text("actor").notNull(),
    /** For a person's event: their GitHub login, when it's known (who resolved a thread, say). */
    actorLogin: text("actor_login"),
    /**
     * For a `resolved` event: false when the resolution didn't count, and the finding stayed
     * open (a blocking or protected finding resolved by the PR's author, or by someone whose
     * write access isn't checked yet). Null otherwise.
     */
    counted: boolean("counted"),
    sha: text("sha"),
    githubCommentId: bigint("github_comment_id", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [index("finding_events_finding_idx").on(t.findingId, t.createdAt)],
);

export const learnings = pgTable(
  "learnings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** GitHub org or user the learning belongs to. */
    org: text("org").notNull(),
    /** owner/name, or null for an org-wide learning. */
    repo: text("repo"),
    /** Limits the learning to matching paths. Null applies to the whole repo. */
    pathGlob: text("path_glob"),
    kind: learningKind("kind").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    status: learningStatus("status").notNull().default("pending"),
    sourceRepo: text("source_repo"),
    sourcePr: integer("source_pr"),
    sourceCommentId: bigint("source_comment_id", { mode: "number" }),
    author: text("author").notNull(),
    /** The author's repo permission when they proposed it: admin, maintain, write, triage, read. */
    authorPermission: text("author_permission").notNull(),
    hits: integer("hits").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("learnings_scope_idx").on(t.org, t.repo, t.status),
    index("learnings_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const providerUsage = pgTable(
  "provider_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => reviewRuns.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    role: text("role").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    limitHit: boolean("limit_hit").notNull().default(false),
    fellBackTo: text("fell_back_to"),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [index("provider_usage_provider_idx").on(t.providerId, t.createdAt)],
);

/**
 * Providers sitting out after a rate limit, a used-up plan or a rejected credential, until
 * `until`. One row per provider, shared by every run, so a limit one batch hits is skipped by
 * the next batch and the next run without another call.
 */
export const providerCooldowns = pgTable("provider_cooldowns", {
  providerId: text("provider_id").primaryKey(),
  until: timestamp("until", { withTimezone: true }).notNull(),
  /** rate_limit, plan_limit or auth. */
  reason: text("reason").notNull(),
  updatedAt: updatedAt(),
});

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    reaction: reaction("reaction").notNull(),
    actor: text("actor").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("feedback_finding_actor_reaction_key").on(t.findingId, t.actor, t.reaction)],
);

/**
 * What the dispatcher last acted on for each PR, so it can order deliveries that GitHub sends
 * out of order. `repo` is lowercased owner/name. A job older than `last_event_at` is stale, and
 * a close wins over a reopen with the same time.
 */
export const pullRequestDispatches = pgTable(
  "pull_request_dispatches",
  {
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    /** The newest event time (the PR's `updated_at`) the dispatcher has acted on. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    /** Set while the newest event closed the PR. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.number] })],
);

/**
 * Review executions the dispatcher started, until it stops them. A PR's unstopped rows are the
 * executions a newer job may need to stop, so the dispatcher never lists the state machine's
 * executions. `repo` is lowercased owner/name.
 */
export const dispatchedExecutions = pgTable(
  "dispatched_executions",
  {
    executionArn: text("execution_arn").primaryKey(),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    headSha: text("head_sha").notNull(),
    /** The event time of the job that started it. */
    eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
    /** When the dispatcher stopped it, or found it had already ended. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("dispatched_executions_active_idx")
      .on(t.repo, t.number)
      .where(sql`${t.stoppedAt} is null`),
  ],
);
