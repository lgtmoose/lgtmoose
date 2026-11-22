import type { ReviewJob, Severity } from "@lgtmoose/core";
import {
  approveLearning,
  forgetLearning,
  learningsForPullRequest,
  proposeLearning,
  summarizeLearning,
  type LearningDeps,
  type LearningStore,
  type OrgRole,
  type Permission,
} from "@lgtmoose/learnings";
import { inline } from "@lgtmoose/summary";
import {
  addressesDocsHandle,
  handleHint,
  helpText,
  learningProposal,
  parseCommands,
  type Command,
} from "./commands.js";
import { describeFinding } from "./explain.js";
import { patternKey, rememberText } from "./outcome-learning.js";
import { JUDGE_REPLY_MARKER, isTrivialReply, type ReplyStore } from "./replies.js";
import { resolutionHeld } from "./thread-policy.js";

/**
 * The conversation handler: comment jobs the dispatcher forwards, on a path that doesn't clone
 * or run a model. Comments that hold `@lgtmoose` commands are handled here; others are left for
 * the reply judge (NIC-833), which this returns `deferred` for.
 *
 * Every fact about who asked comes from GitHub: the comment's author, their permission on the
 * repository, their org role. The comment's text only says which command they asked for.
 * Replies never echo comment text unescaped.
 */

/** Marks our replies, so a reply is never read as a command (bots are skipped besides). */
export const REPLY_MARKER = "<!-- lgtmoose:command-reply -->";

/** The most learnings listed by `learnings`. */
export const MAX_LISTED_LEARNINGS = 30;

/**
 * What a conversation job is about: an issue comment on the PR, a review comment on the diff, or
 * the body of a submitted review (`review`, read for commands only).
 */
export type CommentKind = "comment" | "review_comment" | "review";

/** The kinds GitHub takes reactions on: submitted reviews have no reactions API. */
export type ReactableKind = Exclude<CommentKind, "review">;

/** The comment a job is about, as GitHub reports it. */
export interface CommentInfo {
  body: string;
  author: string;
  authorIsBot: boolean;
  /**
   * For a review comment, the thread's first comment: the one it replies to, or itself when it
   * starts the thread. That's the comment a finding records.
   */
  threadRootId?: number;
  /** When it was written, as GitHub says: how far `comments_through` moves. */
  createdAt?: string;
}

export interface PullInfo {
  headSha: string;
  /** The base commit: where the repo config is read. Left out by older fakes. */
  baseSha?: string;
  author: string;
  open: boolean;
}

export type Reaction = "+1" | "confused";

/** GitHub for one installation, as the conversation handler uses it. `repo` is owner/name. */
export interface ConversationGitHub {
  /** The App's slug: the bot is `@<slug>`. */
  slug(): Promise<string>;
  /** The comment; undefined when it's gone. */
  comment(kind: ReactableKind, repo: string, commentId: number): Promise<CommentInfo | undefined>;
  /** A submitted review's body and author; undefined when it's gone. */
  review(repo: string, number: number, reviewId: number): Promise<CommentInfo | undefined>;
  pull(repo: string, number: number): Promise<PullInfo>;
  /**
   * The bots the repo config at `baseSha` trusts to ask for a review (`review.trusted_bots`).
   * Optional: without it, no bot's comment counts.
   */
  trustedBots?(repo: string, baseSha: string): Promise<readonly string[]>;
  /** The paths the PR changes, at head. */
  files(repo: string, number: number): Promise<string[]>;
  /** The collaborators API: a login's permission on the repository; `none` when unread. */
  permission(repo: string, login: string): Promise<Permission>;
  /** The org memberships API: an owner is `admin`. For a user account, only that user. */
  orgRole(org: string, login: string): Promise<OrgRole>;
  react(kind: ReactableKind, repo: string, commentId: number, content: Reaction): Promise<void>;
  /**
   * A reply: in the thread for a review comment, on the PR for an issue comment or a submitted
   * review (whose `commentId` is then the review's ID).
   */
  reply(
    kind: CommentKind,
    repo: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<void>;
}

/** One of our findings, as `explain` and `ignore` read it. */
export interface StoredFinding {
  id: string;
  severity: Severity;
  ruleCategory: string;
  title: string;
  body: string;
  path: string | undefined;
  line: number | undefined;
  status: string;
  raisedAtSha: string;
}

/** The database, as the conversation handler uses it. `repo` is passed as the job has it. */
export interface ConversationStore {
  /** Pauses automatic reviews of the PR (`by` a login), or resumes them (`undefined`). */
  setPaused(repo: string, number: number, by: string | undefined): Promise<void>;
  /** Whether a run posted for the PR at this head (it was reviewed). */
  reviewedHead(repo: string, number: number, headSha: string): Promise<boolean>;
  /** Our finding whose inline comment is `commentId`. */
  findingByComment(
    repo: string,
    number: number,
    commentId: number,
  ): Promise<StoredFinding | undefined>;
  /** Our findings on `path` at `line` (within their span). */
  findingsAt(repo: string, number: number, path: string, line: number): Promise<StoredFinding[]>;
  /**
   * Declines an open or outdated finding, with a `declined` event by the person. Returns false
   * when it wasn't open or outdated any more.
   */
  decline(findingId: string, login: string, commentId: number): Promise<boolean>;
  /**
   * The reply that last declined or disputed the finding, as the reply judge stored it
   * (redacted; untrusted), for `remember` (NIC-1081). Undefined when there's none on record.
   */
  declineReason?(findingId: string): Promise<{ author: string; body: string } | undefined>;
  /**
   * Moves the PR's `comments_through` up to `at` (never back): comments up to then are
   * handled, so the reconciler only queues ones written later.
   */
  commentsThrough?(repo: string, number: number, at: Date): Promise<void>;
  /**
   * Records that the PR got the one-time hint with the App's real handle (NIC-1119). True the
   * first time, false once it has had one, so the hint is never posted twice on a PR.
   */
  claimHandleHint?(repo: string, number: number): Promise<boolean>;
}

export interface ConversationDeps {
  github(installationId: number): Promise<ConversationGitHub>;
  store: ConversationStore;
  learnings: LearningStore;
  /** The most pending learnings one author may have (`LearningDeps.maxPendingPerAuthor`). */
  maxPendingLearnings?: number;
  /**
   * Replies on our findings' threads, waiting for the reply judge. Left out, replies are
   * deferred as before.
   */
  replies?: ReplyStore;
  /**
   * The most `explain`s the explainer answers per PR per run (`maxExplanations`). Left out or
   * 0, or without `replies`, `explain` replies with the finding as it's stored.
   */
  maxExplanations?: number;
  /**
   * Other handles commands may use besides `@<slug>` (`commandAliases`, NIC-1119), such as
   * `lgtmoose` for an App called `lgtmoose-<org>`. Left out: only the App's own handle.
   */
  commandAliases?: readonly string[];
  /**
   * Outcome learning (NIC-1081): a finding `ignore` declined may complete a repeated rejection.
   * Left out, an `ignore` teaches nothing. Failures are logged, never thrown.
   */
  outcomes?: {
    rejected(
      installationId: number,
      repo: string,
      rejected: readonly { findingId: string; commentId?: number }[],
    ): Promise<void>;
  };
  /** The job queue, for reviews a command asks for. */
  queue: { send(job: ReviewJob): Promise<void> };
  /** In shadow mode nothing is written to GitHub: reactions and replies are logged. */
  shadow: boolean;
  log(message: string, fields?: Record<string, unknown>): void;
  now?: () => Date;
}

export type ConversationResult =
  | { action: "commands"; commands: string[]; ok: boolean; replied: boolean }
  /** A reply on one of our findings' threads, recorded for the judge (`queued`: a run asked). */
  | { action: "reply"; queued: boolean }
  | { action: "deferred"; reason: string }
  | { action: "ignored"; reason: string };

/** What one command did: whether it went through, and what to say, if anything. */
interface Outcome {
  ok: boolean;
  reply?: string;
}

const RANK: Record<Permission, number> = {
  admin: 5,
  maintain: 4,
  write: 3,
  triage: 2,
  read: 1,
  none: 0,
};

const short = (sha: string) => sha.slice(0, 7);
const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The handles commands may use here: the App's own, then the deployment's aliases. */
const handles = (deps: Pick<ConversationDeps, "commandAliases">, slug: string): string[] => [
  slug,
  ...(deps.commandAliases ?? []),
];

/**
 * The one-time hint (NIC-1119) for a comment that used `@lgtmoose` where this App is called
 * something else: posted once per PR, carrying the reply marker so nothing reads it as a
 * command. The PR is claimed before the hint is posted, so a retry never posts it twice; one
 * that fails to post is lost, which is the safer side. Logged, not posted or claimed, in shadow
 * mode. Without a store that records it, there's no hint at all.
 */
async function hintHandle(
  deps: ConversationDeps,
  job: ReviewJob,
  slug: string,
  post: (body: string) => Promise<void>,
): Promise<void> {
  const { store } = deps;
  if (store.claimHandleHint === undefined) return;
  const body = `${handleHint(slug)}\n\n${REPLY_MARKER}`;
  if (deps.shadow) {
    deps.log("shadow: handle hint not posted", { repo: job.repo, prNumber: job.prNumber });
    return;
  }
  if (!(await store.claimHandleHint(job.repo, job.prNumber))) return;
  await post(body);
  deps.log("handle hint posted", { repo: job.repo, prNumber: job.prNumber });
}

interface Context {
  deps: ConversationDeps;
  github: ConversationGitHub;
  job: ReviewJob;
  kind: CommentKind;
  /** The comment's ID; undefined for a submitted review, which isn't a comment. */
  commentId: number | undefined;
  /**
   * What the commands came from, for the IDs that make a request once: `<comment ID>` or
   * `review-<review ID>` (the two are separate ID spaces on GitHub).
   */
  sourceKey: string;
  comment: CommentInfo;
  slug: string;
  owner: string;
  pull: () => Promise<PullInfo>;
  /** A login's permission on the PR's repository. */
  permission: (login: string) => Promise<Permission>;
  /**
   * A login's permission on any repository (`owner/name`), read once per repository and login
   * per job: a learning's own repository may not be the PR's. `none` when the installation
   * can't see it.
   */
  permissionOn: (repo: string, login: string) => Promise<Permission>;
}

function memo<T>(read: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (key) => {
    const lower = key.toLowerCase();
    let value = cache.get(lower);
    if (value === undefined) {
      value = read(key);
      cache.set(lower, value);
    }
    return value;
  };
}

async function hasWrite(context: Context): Promise<boolean> {
  return RANK[await context.permission(context.comment.author)] >= RANK.write;
}

const needsWrite = (what: string): Outcome => ({
  ok: false,
  reply: `\`${what}\` needs write access to this repository.`,
});

async function reviewCommand(context: Context, full: boolean): Promise<Outcome> {
  const pull = await context.pull();
  if (!pull.open) return { ok: false, reply: "This pull request is closed, so it isn't reviewed." };
  // Reviews cost model time: the PR's author or someone with write access may ask for one.
  const isAuthor = sameLogin(context.comment.author, pull.author);
  if (!isAuthor && !(await hasWrite(context))) {
    return {
      ok: false,
      reply: "Only the pull request's author or someone with write access can ask for a review.",
    };
  }
  if (
    !full &&
    (await context.deps.store.reviewedHead(context.job.repo, context.job.prNumber, pull.headSha))
  ) {
    return {
      ok: true,
      reply: `${short(pull.headSha)} is already reviewed. \`@${context.slug} full review\` reviews the whole PR again.`,
    };
  }
  await queueRequestedReview(
    context.deps,
    context.job,
    pull.headSha,
    context.comment.author,
    context.sourceKey,
    { full, ...(context.commentId === undefined ? {} : { commentId: context.commentId }) },
  );
  return { ok: true };
}

/** Queues the review a command asked for. One comment asks once: the delivery ID dedupes. */
async function queueRequestedReview(
  deps: ConversationDeps,
  job: ReviewJob,
  headSha: string,
  actor: string,
  sourceKey: string,
  options: { full: boolean; commentId?: number },
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await deps.queue.send({
    kind: "pr_updated",
    requested: options.full ? "full_review" : "review",
    // A redelivery dedupes on the queue and in the dispatcher.
    deliveryId: `command-${sourceKey}-${options.full ? "full" : "review"}`,
    installationId: job.installationId,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha,
    actor,
    ...(options.commentId === undefined ? {} : { commentId: options.commentId }),
    receivedAt: now.toISOString(),
    eventAt: job.eventAt ?? now.toISOString(),
  });
}

async function pauseCommand(context: Context, pause: boolean): Promise<Outcome> {
  if (!(await hasWrite(context))) return needsWrite(pause ? "pause" : "resume");
  await context.deps.store.setPaused(
    context.job.repo,
    context.job.prNumber,
    pause ? context.comment.author : undefined,
  );
  return { ok: true };
}

/**
 * Asks the explainer about one finding (NIC-1053): records the request and asks for a run,
 * whose post step answers it. False when it isn't asked: then the stored finding is the reply.
 * Only the PR's author or someone with write access asks, since it costs model time, and only
 * about an open or outdated finding on an open PR.
 */
async function askExplainer(
  context: Context,
  finding: StoredFinding,
  where: "thread" | "pr",
): Promise<boolean> {
  const { deps, job, commentId } = context;
  if (deps.replies === undefined || (deps.maxExplanations ?? 0) <= 0) return false;
  // A submitted review's body isn't a comment: nothing to record the request by, so its
  // `explain path:line` gets the stored finding in the review's reply.
  if (commentId === undefined) return false;
  if (finding.status !== "open" && finding.status !== "outdated") return false;
  const pull = await context.pull();
  if (!pull.open) return false;
  if (!sameLogin(context.comment.author, pull.author) && !(await hasWrite(context))) return false;
  const added = await deps.replies.add({
    repo: job.repo,
    prNumber: job.prNumber,
    findingId: finding.id,
    commentId,
    author: context.comment.author,
    body: context.comment.body,
    kind: where === "thread" ? "explain" : "explain_pr",
  });
  // A redelivery: its run was asked for the first time.
  if (!added) return true;
  const now = deps.now?.() ?? new Date();
  await deps.queue.send({
    kind: "pr_updated",
    requested: "explain",
    // One comment asks once: a redelivery dedupes on the queue and in the dispatcher.
    deliveryId: `explain-${commentId}`,
    installationId: job.installationId,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha: pull.headSha,
    actor: context.comment.author,
    commentId,
    receivedAt: now.toISOString(),
    eventAt: job.eventAt ?? now.toISOString(),
  });
  return true;
}

async function explainCommand(
  context: Context,
  at: { path: string; line: number } | undefined,
): Promise<Outcome> {
  const { store } = context.deps;
  const { repo, prNumber } = context.job;
  let found: StoredFinding[] = [];
  if (at !== undefined) {
    found = await store.findingsAt(repo, prNumber, at.path, at.line);
  } else if (context.comment.threadRootId !== undefined) {
    const finding = await store.findingByComment(repo, prNumber, context.comment.threadRootId);
    found = finding === undefined ? [] : [finding];
  } else {
    return {
      ok: false,
      reply: `\`explain\` works in a finding's thread, or as \`@${context.slug} explain path:line\`.`,
    };
  }
  if (found.length === 0) return { ok: false, reply: "I have no finding there." };
  // One finding: the explainer answers, in a later run. Several at one line: the stored ones.
  const [only] = found;
  if (
    found.length === 1 &&
    only !== undefined &&
    (await askExplainer(context, only, at === undefined ? "thread" : "pr"))
  ) {
    return { ok: true };
  }
  return { ok: true, reply: found.slice(0, 3).map(describeFinding).join("\n\n---\n\n") };
}

async function ignoreCommand(context: Context): Promise<Outcome> {
  const root = context.comment.threadRootId;
  const commentId = context.commentId;
  if (context.kind !== "review_comment" || root === undefined || commentId === undefined) {
    return { ok: false, reply: "`ignore` works as a reply in one of my findings' threads." };
  }
  const finding = await context.deps.store.findingByComment(
    context.job.repo,
    context.job.prNumber,
    root,
  );
  if (finding === undefined) return { ok: false, reply: "This thread isn't one of my findings." };
  if (finding.status !== "open" && finding.status !== "outdated") {
    return { ok: true, reply: `This finding is already ${finding.status.replaceAll("_", " ")}.` };
  }
  // Same rule as resolving its thread: a finding that holds a merge isn't self-service.
  const pull = await context.pull();
  const held = await resolutionHeld(
    finding,
    context.comment.author,
    pull.author,
    context.permission,
  );
  if (held !== undefined) {
    return {
      ok: false,
      reply:
        held === "author"
          ? "A blocking finding can't be ignored by the pull request's author. Someone else with write access can."
          : "A blocking finding can only be ignored by someone with write access.",
    };
  }
  const declined = await context.deps.store.decline(finding.id, context.comment.author, commentId);
  if (!declined) return { ok: true, reply: "This finding was already closed." };
  const { outcomes } = context.deps;
  if (outcomes !== undefined) {
    try {
      await outcomes.rejected(context.job.installationId, context.job.repo, [
        { findingId: finding.id, commentId },
      ]);
    } catch (error) {
      context.deps.log("outcomes not learned from", {
        findingId: finding.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ok: true };
}

/**
 * `remember` in a declined finding's thread (NIC-1081): a learning not to raise findings like it
 * in this repo, from the finding and the reason it was declined with. It goes through the
 * learnings policy as the commenter's: active with write access, pending otherwise, refused for
 * a protected category. A trusted bot never gets here (`handleBotComment`).
 */
async function rememberCommand(context: Context): Promise<Outcome> {
  const root = context.comment.threadRootId;
  const commentId = context.commentId;
  if (context.kind !== "review_comment" || root === undefined || commentId === undefined) {
    return {
      ok: false,
      reply: "`remember` works as a reply in one of my declined findings' threads.",
    };
  }
  const { store } = context.deps;
  const finding = await store.findingByComment(context.job.repo, context.job.prNumber, root);
  if (finding === undefined) return { ok: false, reply: "This thread isn't one of my findings." };
  if (finding.status !== "declined" && finding.status !== "disputed") {
    return {
      ok: false,
      reply: `There's nothing to remember yet: this finding is ${finding.status.replaceAll("_", " ")}. Decline it first, with a reason.`,
    };
  }
  const reason = await store.declineReason?.(finding.id);
  const result = await proposeLearning(
    learningDeps(context),
    {
      kind: "scoping",
      category: finding.ruleCategory,
      text: rememberText(finding, reason?.body),
      scope: { level: "repo" },
    },
    {
      repo: context.job.repo,
      pr: context.job.prNumber,
      commentId,
      author: context.comment.author,
    },
    { patternKey: patternKey(finding.ruleCategory, finding.title) },
  );
  if (result.outcome === "refused") {
    return { ok: false, reply: `Not remembered: ${inline(result.reason)}.` };
  }
  const state =
    result.outcome === "active"
      ? "is active"
      : "is pending: it applies once someone with write access approves it";
  return {
    ok: true,
    reply: `Learning \`${result.learning.id}\` (not raising findings like this one here) ${state}.`,
  };
}

function learningDeps(context: Context): LearningDeps {
  return {
    store: context.deps.learnings,
    // The permission on the repository asked about (a learning's source repository), never
    // just the PR's: write on one repository mustn't approve or forget another's learnings.
    permissions: (repo, login) => context.permissionOn(repo, login),
    orgRoles: (org, login) => context.github.orgRole(org, login),
    ...(context.deps.maxPendingLearnings === undefined
      ? {}
      : { maxPendingPerAuthor: context.deps.maxPendingLearnings }),
  };
}

async function learnCommand(context: Context, text: string): Promise<Outcome> {
  const result = await proposeLearning(learningDeps(context), learningProposal(text), {
    repo: context.job.repo,
    pr: context.job.prNumber,
    // A review's ID isn't a comment ID, so a learning from a review body records none.
    ...(context.commentId === undefined ? {} : { commentId: context.commentId }),
    author: context.comment.author,
  });
  if (result.outcome === "refused") {
    return { ok: false, reply: `Not learned: ${inline(result.reason)}.` };
  }
  const { learning } = result;
  const redacted =
    result.redacted.length === 0 ? "" : ` Removed from the text: ${result.redacted.join(", ")}.`;
  const state =
    result.outcome === "active"
      ? "is active"
      : `is pending: it applies once someone with ${learning.repo === undefined ? "the org's owner role" : "write access"} approves it`;
  return {
    ok: true,
    reply: `Learning \`${learning.id}\` (${learning.kind}, ${inline(summarizeLearning(learning).scope)}) ${state}.${redacted}`,
  };
}

async function forgetCommand(context: Context, id: string): Promise<Outcome> {
  // Only this account's learnings: an ID from elsewhere is as good as unknown.
  const learning = await context.deps.learnings.get(id);
  if (learning === undefined || !sameLogin(learning.org, context.owner)) {
    return { ok: false, reply: "There's no such learning here." };
  }
  const result = await forgetLearning(learningDeps(context), id, {
    login: context.comment.author,
    ...(context.commentId === undefined ? {} : { commentId: context.commentId }),
  });
  if (result.outcome === "refused")
    return { ok: false, reply: `Not forgotten: ${inline(result.reason)}.` };
  if (result.outcome === "unchanged")
    return { ok: true, reply: "That learning is already retired." };
  return { ok: true };
}

async function approveCommand(context: Context, id: string): Promise<Outcome> {
  // Only this account's learnings: an ID from elsewhere is as good as unknown.
  const learning = await context.deps.learnings.get(id);
  if (learning === undefined || !sameLogin(learning.org, context.owner)) {
    return { ok: false, reply: "There's no such learning here." };
  }
  const result = await approveLearning(learningDeps(context), id, {
    login: context.comment.author,
    ...(context.commentId === undefined ? {} : { commentId: context.commentId }),
  });
  if (result.outcome === "refused") {
    return { ok: false, reply: `Not approved: ${inline(result.reason)}.` };
  }
  if (result.outcome === "unchanged") {
    return {
      ok: true,
      reply:
        result.learning?.status === "active"
          ? "That learning is already active."
          : "Only a pending learning can be approved.",
    };
  }
  return { ok: true, reply: `Learning \`${result.learning.id}\` is active.` };
}

async function learningsCommand(context: Context): Promise<Outcome> {
  const paths = await context.github.files(context.job.repo, context.job.prNumber);
  const found = await learningsForPullRequest(context.deps.learnings, {
    org: context.owner,
    repo: context.job.repo,
    paths,
  });
  if (found.length === 0) return { ok: true, reply: "No learnings apply to this pull request." };
  const rows = found.slice(0, MAX_LISTED_LEARNINGS).map((learning) => {
    const summary = summarizeLearning(learning);
    const text = summary.text.length > 200 ? `${summary.text.slice(0, 199)}…` : summary.text;
    return `| \`${summary.id}\` | ${summary.kind} | ${inline(summary.scope)} | ${inline(text)} |`;
  });
  const more =
    found.length > MAX_LISTED_LEARNINGS
      ? [``, `…and ${found.length - MAX_LISTED_LEARNINGS} more.`]
      : [];
  return {
    ok: true,
    reply: [
      "Learnings that apply to this pull request:",
      "",
      "| ID | Kind | Scope | Learning |",
      "| --- | --- | --- | --- |",
      ...rows,
      ...more,
    ].join("\n"),
  };
}

async function run(context: Context, command: Command): Promise<Outcome> {
  switch (command.name) {
    case "help":
      return { ok: true, reply: helpText(context.slug) };
    case "unknown":
      return { ok: false, reply: helpText(context.slug) };
    case "review":
      return reviewCommand(context, command.full);
    case "pause":
      return pauseCommand(context, true);
    case "resume":
      return pauseCommand(context, false);
    case "explain":
      return explainCommand(context, command.at);
    case "ignore":
      return ignoreCommand(context);
    case "remember":
      return rememberCommand(context);
    case "learn":
      return learnCommand(context, command.text);
    case "forget":
      return forgetCommand(context, command.id);
    case "approve":
      return approveCommand(context, command.id);
    case "learnings":
      return learningsCommand(context);
  }
}

/**
 * A bot's comment (NIC-1077). Bots are ignored, except one the repo lists in
 * `review.trusted_bots` (its config at the PR's base, which the PR can't change) asking
 * `@lgtmoose review` in an issue comment: a coding agent saying its PR is ready. That's all a
 * trusted bot can do: no other command, not `full review`, and no reply, so two bots never talk
 * to each other. LGTMoose's own comments never count. The 👍 says the review was asked for.
 */
async function handleBotComment(
  deps: ConversationDeps,
  github: ConversationGitHub,
  job: ReviewJob & { commentId: number },
  comment: CommentInfo,
): Promise<ConversationResult> {
  const ignored = { action: "ignored", reason: "a bot's comment" } as const;
  if (job.kind !== "comment" || github.trustedBots === undefined) return ignored;
  const slug = await github.slug();
  if (sameLogin(comment.author, `${slug}[bot]`)) return ignored;
  const commands = parseCommands(comment.body, handles(deps, slug));
  if (!commands.some((command) => command.name === "review" && !command.full)) return ignored;
  const pull = await github.pull(job.repo, job.prNumber);
  if (!pull.open || pull.baseSha === undefined) return ignored;
  const trusted = await github.trustedBots(job.repo, pull.baseSha);
  if (!trusted.some((bot) => sameLogin(bot, comment.author))) {
    return { action: "ignored", reason: "a bot the repository doesn't trust" };
  }
  if (await deps.store.reviewedHead(job.repo, job.prNumber, pull.headSha)) {
    return { action: "commands", commands: ["review"], ok: true, replied: false };
  }
  await queueRequestedReview(deps, job, pull.headSha, comment.author, String(job.commentId), {
    full: false,
    commentId: job.commentId,
  });
  if (deps.shadow) {
    deps.log("shadow: command reaction not posted", { repo: job.repo, commentId: job.commentId });
  } else {
    await github.react("comment", job.repo, job.commentId, "+1");
  }
  return { action: "commands", commands: ["review"], ok: true, replied: false };
}

/** Handles one forwarded comment job. Throws when it should be retried. */
export async function handleConversation(
  deps: ConversationDeps,
  job: ReviewJob,
): Promise<ConversationResult> {
  if (job.kind === "review") return handleReview(deps, job);
  if (job.kind !== "comment" && job.kind !== "review_comment") {
    return { action: "deferred", reason: `${job.kind} jobs arrive with M5` };
  }
  if (job.commentId === undefined) return { action: "ignored", reason: "no comment ID" };
  const kind: ReactableKind = job.kind;
  const commentId = job.commentId;
  const github = await deps.github(job.installationId);
  const comment = await github.comment(kind, job.repo, commentId);
  if (comment === undefined) return { action: "ignored", reason: "the comment is gone" };
  if (comment.body.includes(REPLY_MARKER) || comment.body.includes(JUDGE_REPLY_MARKER)) {
    return { action: "ignored", reason: "a bot's comment" };
  }
  if (comment.authorIsBot) return handleBotComment(deps, github, { ...job, commentId }, comment);
  // Handled one way or another from here: the reconciler needn't queue it again.
  const handled = async () => {
    if (comment.createdAt === undefined || deps.store.commentsThrough === undefined) return;
    const at = new Date(comment.createdAt);
    if (!Number.isNaN(at.getTime())) {
      await deps.store.commentsThrough(job.repo, job.prNumber, at);
    }
  };
  const slug = await github.slug();
  const commands = parseCommands(comment.body, handles(deps, slug));
  // Not a command: a reply for the judge, if it's on one of our findings' threads.
  if (commands.length === 0) {
    if (addressesDocsHandle(comment.body, handles(deps, slug))) {
      await hintHandle(deps, job, slug, (body) =>
        github.reply(kind, job.repo, job.prNumber, commentId, body),
      );
    }
    const result = await recordReply(deps, github, { ...job, commentId }, kind, comment);
    await handled();
    return result;
  }

  const { ok, names, body } = await runCommands(deps, github, job, comment, slug, commands, {
    kind,
    commentId,
    sourceKey: String(commentId),
  });
  const reaction: Reaction = ok ? "+1" : "confused";
  if (deps.shadow) {
    deps.log("shadow: command reply not posted", {
      repo: job.repo,
      prNumber: job.prNumber,
      commentId,
      commands: names,
      reaction,
      ...(body === undefined ? {} : { reply: body }),
    });
  } else {
    await github.react(kind, job.repo, commentId, reaction);
    if (body !== undefined) await github.reply(kind, job.repo, job.prNumber, commentId, body);
  }
  await handled();
  return { action: "commands", commands: names, ok, replied: body !== undefined };
}

/** Runs a comment's or review's commands in order, and builds the reply to post. */
async function runCommands(
  deps: ConversationDeps,
  github: ConversationGitHub,
  job: ReviewJob,
  comment: CommentInfo,
  slug: string,
  commands: readonly Command[],
  source: Pick<Context, "kind" | "commentId" | "sourceKey">,
): Promise<{ ok: boolean; names: string[]; body: string | undefined; replies: string[] }> {
  const [owner = ""] = job.repo.split("/");
  let pull: Promise<PullInfo> | undefined;
  const permission = memo((login) => github.permission(job.repo, login));
  const otherPermission = memo((key) => {
    const [repo = "", login = ""] = key.split("\n");
    return github.permission(repo, login);
  });
  const context: Context = {
    deps,
    github,
    job,
    ...source,
    comment,
    slug,
    owner,
    pull: () => (pull ??= github.pull(job.repo, job.prNumber)),
    permission,
    permissionOn: (repo, login) =>
      repo.toLowerCase() === job.repo.toLowerCase()
        ? permission(login)
        : otherPermission(`${repo}\n${login}`),
  };
  const outcomes: Outcome[] = [];
  for (const command of commands) outcomes.push(await run(context, command));

  const ok = outcomes.every((outcome) => outcome.ok);
  const replies = [...new Set(outcomes.flatMap((outcome) => outcome.reply ?? []))];
  const body = replies.length === 0 ? undefined : `${replies.join("\n\n")}\n\n${REPLY_MARKER}`;
  return { ok, names: commands.map((command) => command.name), body, replies };
}

/**
 * The `@lgtmoose` commands in a submitted review's body. Same parser and rules as a comment's,
 * with three differences. GitHub has no reactions API for reviews, so the outcome is always a
 * reply on the PR (an issue comment), saying "Done." when a command had nothing else to say. A
 * review without commands is left alone: review bodies never go to the reply judge. And the
 * review's ID isn't a comment ID, so nothing it does records one; the IDs that make a request
 * once use `review-<ID>` instead.
 */
async function handleReview(deps: ConversationDeps, job: ReviewJob): Promise<ConversationResult> {
  if (job.reviewId === undefined) return { action: "ignored", reason: "no review ID" };
  const reviewId = job.reviewId;
  const github = await deps.github(job.installationId);
  const review = await github.review(job.repo, job.prNumber, reviewId);
  if (review === undefined) return { action: "ignored", reason: "the review is gone" };
  if (
    review.authorIsBot ||
    review.body.includes(REPLY_MARKER) ||
    review.body.includes(JUDGE_REPLY_MARKER)
  ) {
    return { action: "ignored", reason: "a bot's review" };
  }
  const slug = await github.slug();
  const commands = parseCommands(review.body, handles(deps, slug));
  if (commands.length === 0) {
    if (addressesDocsHandle(review.body, handles(deps, slug))) {
      await hintHandle(deps, job, slug, (body) =>
        github.reply("review", job.repo, job.prNumber, reviewId, `@${review.author}: ${body}`),
      );
    }
    return { action: "ignored", reason: "no commands in the review" };
  }

  const { ok, names, replies } = await runCommands(deps, github, job, review, slug, commands, {
    kind: "review",
    commentId: undefined,
    sourceKey: `review-${reviewId}`,
  });
  const text = replies.length === 0 ? [ok ? "Done." : "That didn't work."] : replies;
  const body = `@${review.author}: ${text.join("\n\n")}\n\n${REPLY_MARKER}`;
  if (deps.shadow) {
    deps.log("shadow: command reply not posted", {
      repo: job.repo,
      prNumber: job.prNumber,
      reviewId,
      commands: names,
      reply: body,
    });
  } else {
    await github.reply("review", job.repo, job.prNumber, reviewId, body);
  }
  return { action: "commands", commands: names, ok, replied: true };
}

/**
 * A comment that isn't a command. A person's reply on one of our open findings' threads is
 * recorded for the reply judge, and a run is asked for so it's judged without waiting for a
 * push (`requested: "replies"`; the dispatcher leaves it alone on a paused PR). Thanks, emoji
 * and other replies with nothing to judge are left alone, and so is everything else: top-level
 * comments and other reviewers' threads.
 */
async function recordReply(
  deps: ConversationDeps,
  github: ConversationGitHub,
  job: ReviewJob & { commentId: number },
  kind: CommentKind,
  comment: CommentInfo,
): Promise<ConversationResult> {
  const root = comment.threadRootId;
  if (kind !== "review_comment" || root === undefined || root === job.commentId) {
    return { action: "deferred", reason: "not a reply on a review thread" };
  }
  if (deps.replies === undefined) return { action: "deferred", reason: "no reply judge" };
  const finding = await deps.store.findingByComment(job.repo, job.prNumber, root);
  if (finding === undefined)
    return { action: "ignored", reason: "not one of our findings' threads" };
  if (finding.status !== "open" && finding.status !== "outdated") {
    return { action: "ignored", reason: `the finding is ${finding.status}` };
  }
  if (isTrivialReply(comment.body)) return { action: "ignored", reason: "nothing to judge" };
  const added = await deps.replies.add({
    repo: job.repo,
    prNumber: job.prNumber,
    findingId: finding.id,
    commentId: job.commentId,
    author: comment.author,
    body: comment.body,
  });
  // A redelivery: its run was asked for the first time.
  if (!added) return { action: "reply", queued: false };
  const pull = await github.pull(job.repo, job.prNumber);
  if (!pull.open) return { action: "reply", queued: false };
  const now = deps.now?.() ?? new Date();
  await deps.queue.send({
    kind: "pr_updated",
    requested: "replies",
    // One reply asks once: a redelivery dedupes on the queue and in the dispatcher.
    deliveryId: `replies-${job.commentId}`,
    installationId: job.installationId,
    repo: job.repo,
    prNumber: job.prNumber,
    headSha: pull.headSha,
    actor: comment.author,
    commentId: job.commentId,
    receivedAt: now.toISOString(),
    eventAt: job.eventAt ?? now.toISOString(),
  });
  return { action: "reply", queued: true };
}
