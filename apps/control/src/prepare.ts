import { join } from "node:path";
import { effectiveCaps, parseRepoConfigYaml, tierPrices, type Tier } from "@lgtmoose/config";
import { SKIP_LABEL, findingSchema } from "@lgtmoose/core";
import type { Repo } from "@lgtmoose/git";
import {
  batchInputSchema,
  prepareReview,
  runKeys,
  type BatchInput,
  type PreparedReview,
  type PullRequest,
  type ResumedWork,
} from "@lgtmoose/pipeline";
import {
  EXPLAINER_TIER,
  REPLY_JUDGE_TIER,
  TICKET_CHECKER_TIER,
  buildReplyJudgePrompt,
} from "@lgtmoose/roles";
import { EXPLAIN_TIMEOUT_MS, explainJobs, type ExplainJob } from "./explain.js";
import { jobTarget, type WorkflowJob } from "./job.js";
import { TICKET_TIMEOUT_MS, prepareTickets, type TicketsManifest } from "./tickets.js";
import { reviewGate, waitingCheckRun } from "./trigger.js";
import {
  checksGate,
  checksState,
  checksToWaitFor,
  timedOutNotice,
  waitState,
  waitingForChecksRun,
} from "./checks-gate.js";
import { z } from "zod";
import { readOutcome } from "./outcomes.js";
import type { ControlDeps, FindingRecord } from "./ports.js";
import type { PendingReply } from "./replies.js";
import {
  RUN_ALL,
  capReason,
  liftsPrCaps,
  planSpend,
  quietlyCapped,
  reserveSpend,
  type CapKind,
  type PlannedBatch,
} from "./spend.js";

/** How the batches are run, from the control task's environment. */
export interface PrepareSettings {
  /** The reviewer's model; empty for the harness's default. */
  model: string;
  batchTimeoutMs: number;
  /** The most replies the reply judge reads in this run. Left out: none. */
  maxReplyJudgements?: number;
  /** The most `explain`s the explainer answers in this run. Left out: none. */
  maxExplanations?: number;
}

/**
 * One reply the reply judge reads in this run: its batch, and what the post step needs to act
 * on the judgement. Written by the prepare step (trusted), not by the model.
 */
export interface JudgeJob {
  index: number;
  replyId: string;
  findingId: string;
  /** The reply's review comment ID: the thread the answer goes in. */
  commentId: number;
  /** The reply's author, from GitHub. */
  author: string;
  /** The finding's file changed between the commit it was raised at and this head. */
  fileChanged: boolean;
}

export const MANIFEST_VERSION = 2;

/** What `runs/<id>/prepared.json` holds: the prepared review and the installation it's for. */
export interface RunManifest {
  version: typeof MANIFEST_VERSION;
  installationId: number;
  review: PreparedReview;
  /** Why the run was asked for, when it was (`WorkflowJob.requested`). */
  requested?: WorkflowJob["requested"];
  /** The replies the reply judge reads in this run (their batches follow the review's). */
  judgements?: JudgeJob[];
  /** The PR's linked tickets (NIC-839); their checker batches follow the judges'. */
  tickets?: TicketsManifest;
  /** The `explain`s this run answers (NIC-1053); their batches follow the tickets'. */
  explanations?: ExplainJob[];
  /**
   * The spend cap that kept batches from running (NIC-1079): which, the review batches it kept
   * (not dispatched), and what the summary says.
   */
  spendCap?: { kind: CapKind; batches: number[]; reason: string };
  /** Notes for the summary about how the run started, such as that it didn’t wait for CI. */
  notices?: string[];
  /**
   * A run for replies or `explain` while the PR's code waits for a review trigger (NIC-1077): it
   * has judge and explainer batches only, and its post step writes their replies and nothing
   * else. No review, check run, summary or label, and the PR's last reviewed head stays put.
   */
  conversationOnly?: true;
}

/** What a ticket a spend cap kept from being checked says instead of its checklist. */
export const TICKET_SPEND_CAP_NOTE = "Not checked: a spend cap was reached.";

/** A manifest written before incremental reviews: the review lacks the fields they added. */
interface LegacyManifest {
  version: 1;
  installationId: number;
  review: Omit<PreparedReview, "kind" | "done" | "carried" | "unchanged" | "noLongerChanged">;
}

/** What the prepare step hands the state machine: the run and the batches to map over. */
export interface PrepareOutput {
  runId: string;
  /** True when the PR's head moved on before the run started; nothing else runs then. */
  superseded: boolean;
  /** The batches with a prompt, for the map state. Moved-only batches aren't listed. */
  batches: { index: number }[];
}

/**
 * Gives the sandbox's checkout every object `git diff` and `git show` need for the PR's files,
 * then stops it fetching more: sandboxes can't reach GitHub, so a lazy fetch would only hang
 * on the egress proxy. Commands that need other history fail at once instead.
 */
async function sealCheckout(repo: Repo, prepared: PreparedReview): Promise<void> {
  const blobs = prepared.files.flatMap((file) =>
    file.submodule ? [] : [file.oldBlob, file.newBlob].filter((b): b is string => b !== undefined),
  );
  await repo.readBlobs(blobs);
  for (const key of ["remote.origin.promisor", "remote.origin.partialclonefilter"]) {
    await repo.git(["config", "--unset-all", key], { okExitCodes: [5] });
  }
}

/** How many of a PR's unposted runs are looked at for finished batches. */
export const RESUME_RUNS = 3;

function runKind(
  prepared: PreparedReview,
  lastReviewed: string | undefined,
): "first" | "incremental" | "full" {
  if (lastReviewed === undefined) return "first";
  return prepared.kind;
}

const depth = z.enum(["full", "mechanical", "move"]);
const reviewedFile = z.object({ path: z.string(), blobSha: z.string(), depth });

/**
 * The parts of a version 2 manifest that incremental reviews added or changed shape, checked
 * so a manifest of another shape (one from an earlier build of this version) is refused rather
 * than misread. The rest is passed through as written.
 */
const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  installationId: z.number().int().positive(),
  review: z.looseObject({
    kind: z.enum(["full", "incremental"]),
    done: z.array(z.object({ path: z.string(), depth })),
    carried: z.array(z.object({ files: z.array(z.string()), findings: z.array(findingSchema) })),
    unchanged: z.array(reviewedFile),
    noLongerChanged: z.array(z.object({ path: z.string(), lines: z.array(z.string()) })),
    jobs: z.array(
      z.looseObject({
        index: z.number().int().min(0),
        files: z.array(z.string()),
        prompt: z.string().optional(),
      }),
    ),
    files: z.array(z.looseObject({ path: z.string() })),
    plan: z.looseObject({ files: z.array(z.unknown()), skipped: z.array(z.unknown()) }),
  }),
});

/**
 * Parses a run's manifest. Written by the run's own prepare step with the control task's role:
 * trusted, not model output, but its shape is checked (see `manifestSchema`). A version 1
 * manifest from before incremental reviews (it has none of their fields) gets them, so a run
 * prepared before a deploy still posts after it. Anything else is refused rather than guessed
 * at.
 */
export function readManifest(text: string): RunManifest {
  const manifest = JSON.parse(text) as { version?: unknown; review?: Record<string, unknown> };
  if (manifest.version === MANIFEST_VERSION) {
    const parsed = manifestSchema.safeParse(manifest);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
      throw new Error(`Unsupported run manifest (version 2, unexpected fields: ${fields}).`);
    }
    return manifest as unknown as RunManifest;
  }
  const incrementalFields = ["kind", "done", "carried", "unchanged", "noLongerChanged"].filter(
    (field) => manifest.review !== undefined && field in manifest.review,
  );
  if (manifest.version !== 1 || manifest.review === undefined || incrementalFields.length > 0) {
    throw new Error(`Unsupported run manifest (version ${JSON.stringify(manifest.version)}).`);
  }
  const legacy = manifest as unknown as LegacyManifest;
  return {
    ...legacy,
    version: MANIFEST_VERSION,
    review: {
      ...legacy.review,
      kind: "full",
      done: [],
      carried: [],
      unchanged: [],
      noLongerChanged: [],
    },
  };
}

/**
 * The finished batches of the PR's recent runs that never posted (stopped by a newer push,
 * superseded or failed): the files each batch's prompt covered, at the blobs and depth it saw
 * them, and its findings. This run skips the files whose blobs haven't changed and posts their
 * findings. Nothing about them is recorded: only a posted run's files count as reviewed (see
 * `RunStore.reviewedFiles`), and the outputs stay in the artifact bucket for the next run.
 *
 * Files a batch had as done already are left out: their findings, if any, came from an older
 * run, and are picked up from that run while it's among the recent ones. Past that, the file
 * is reviewed again rather than its findings lost.
 */
async function resumableWork(
  deps: ControlDeps,
  pullRequestId: string,
  runId: string,
): Promise<ResumedWork[]> {
  const earlierIds = await deps.runs.unpostedRuns(pullRequestId, runId, RESUME_RUNS);
  const perRun = await Promise.all(earlierIds.map((id) => resumableBatches(deps, id)));
  return perRun.flat();
}

async function resumableBatches(deps: ControlDeps, earlierId: string): Promise<ResumedWork[]> {
  const text = await deps.store.getText(runKeys(earlierId).prepared);
  // A run stopped before its prepare step finished has nothing to pick up.
  if (text === undefined) return [];
  let review: PreparedReview;
  try {
    ({ review } = readManifest(text));
  } catch (error) {
    // One unreadable earlier manifest mustn't stop every later run: its work is reviewed again.
    deps.log("skipped an unreadable earlier manifest", {
      runId: earlierId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const byPath = new Map(review.files.map((file) => [file.path, file]));
  const depthOf = new Map(review.plan.files.map((planned) => [planned.file.path, planned.depth]));
  const alreadyDone = new Set(review.done.map((entry) => entry.path));
  const jobs = review.jobs.filter((job) => job.prompt !== undefined);
  const outcomes = await Promise.all(
    jobs.map((job) => readOutcome(deps.store, earlierId, job.index)),
  );
  return jobs.flatMap((job, i) => {
    const findings = outcomes[i]?.findings;
    if (findings === undefined) return [];
    const covered = job.files.filter((path) => !alreadyDone.has(path));
    const paths = new Set(covered);
    const files = covered.flatMap((path) => {
      const file = byPath.get(path);
      const depth = depthOf.get(path);
      return file === undefined || depth === undefined
        ? []
        : [{ path, oldBlob: file.oldBlob, newBlob: file.newBlob, depth }];
    });
    return [{ files, findings: findings.filter((finding) => paths.has(finding.path)) }];
  });
}

/** The longest a reply judge run may take: it reads one finding's file, on the fast tier. */
export const JUDGE_TIMEOUT_MS = 5 * 60_000;

/**
 * Whether `path` differs between `from` and `to`. False when `from` can't be fetched (it was
 * force-pushed away): then nothing shows the file changed since the finding was raised.
 */
async function fileChangedSince(
  repo: Repo,
  from: string,
  to: string,
  path: string,
): Promise<boolean> {
  try {
    await repo.fetchCommits([from]);
    const names = await repo.git(["diff", "--name-only", from, to, "--", path]);
    return names.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * The replies the reply judge reads in this run: the PR's pending ones (each finding's latest,
 * oldest first, up to the limit), on findings still open or outdated, each with its prompt and
 * a batch index after the review's. A reply on a finding closed since is skipped.
 */
async function takeReplies(
  deps: ControlDeps,
  pullRequestId: string,
  settings: PrepareSettings,
): Promise<{ pending: PendingReply[]; open: Map<string, FindingRecord> }> {
  const limit = settings.maxReplyJudgements ?? 0;
  if (deps.replies === undefined || limit <= 0) return { pending: [], open: new Map() };
  const pending = await deps.replies.take(pullRequestId, limit);
  if (pending.length === 0) return { pending, open: new Map() };
  const open = new Map(
    (await deps.findings.trackedFindings(pullRequestId)).map((record) => [record.id, record]),
  );
  return { pending, open };
}

/**
 * The review threads of findings someone replied on, left out of the reviewer's context: so the
 * reviewer, not told about our comment, checks a claimed fix on its own (`hiddenThreads`).
 */
function repliedThreads(taken: Awaited<ReturnType<typeof takeReplies>>): Set<number> {
  return new Set(
    taken.pending.flatMap((reply) => {
      const id = taken.open.get(reply.findingId)?.githubCommentId;
      return id === undefined ? [] : [id];
    }),
  );
}

async function judgeJobs(
  deps: ControlDeps,
  { pending, open }: Awaited<ReturnType<typeof takeReplies>>,
  repo: Repo,
  headSha: string,
  prepared: PreparedReview,
): Promise<(JudgeJob & { prompt: string })[]> {
  if (pending.length === 0 || deps.replies === undefined) return [];
  const first = Math.max(-1, ...prepared.jobs.map((job) => job.index)) + 1;
  const judges: (JudgeJob & { prompt: string })[] = [];
  const gone: string[] = [];
  for (const reply of pending) {
    const record = open.get(reply.findingId);
    if (record === undefined) {
      gone.push(reply.id);
      continue;
    }
    const file = record.side === "LEFT" ? (record.basePath ?? record.path) : record.path;
    judges.push({
      index: first + judges.length,
      replyId: reply.id,
      findingId: record.id,
      commentId: reply.commentId,
      author: reply.author,
      fileChanged: await fileChangedSince(repo, record.raisedAtSha, headSha, file),
      prompt: buildReplyJudgePrompt({
        finding: {
          severity: record.severity,
          ruleCategory: record.ruleCategory,
          title: record.title,
          body: record.body,
          path: record.path,
          line: record.line,
          side: record.side,
          raisedAtSha: record.raisedAtSha,
        },
        reply: reply.body,
        headSha,
      }),
    });
  }
  if (gone.length > 0) await deps.replies.finish(gone, "skipped");
  if (judges.length > 0) deps.log("replies to judge", { count: judges.length });
  return judges;
}

type RunGitHub = Awaited<ReturnType<ControlDeps["github"]>>;

/**
 * The handle a check run names when it says how to ask for a review (NIC-1119): the App's slug,
 * or the deployment's first alias when the slug can't be read. Undefined when there's neither,
 * and then the check run names no handle rather than guess `@lgtmoose`.
 */
async function commandHandle(
  deps: Pick<ControlDeps, "commandAliases">,
  github: { slug?: () => Promise<string> },
): Promise<string | undefined> {
  try {
    const slug = await github.slug?.();
    if (slug !== undefined) return slug;
  } catch {
    // Falls back below.
  }
  return deps.commandAliases?.[0];
}

/**
 * What this run does, by the repo's `review` config at the base (`reviewGate`, NIC-1077), read
 * before anything is cloned:
 *
 * - `review`: the usual run. With `review.label_once`, the label comes off as it starts.
 * - `skip`: nothing, ended like a superseded run. One that waits for a trigger says so in its
 *   check run; one that isn't a trigger at all (a label that isn't the review label) posts
 *   nothing.
 * - `conversation`: a run for replies or `explain` while the code waits for a trigger. It judges
 *   and explains, but reviews no code and doesn't move the PR's last reviewed head, so the new
 *   commits stay unreviewed. The check run says it waits, as a push's would.
 *
 * Without a way to read the config (the CLI), every run reviews.
 */
async function triggered(
  deps: ControlDeps,
  github: RunGitHub,
  job: WorkflowJob,
  target: ReturnType<typeof jobTarget>,
  pr: PullRequest,
  runId: string,
  reviewedBefore: boolean,
): Promise<{ mode: "review" | "conversation" | "skip"; notices?: string[] }> {
  if (github.reader.fileAt === undefined) return { mode: "review" };
  const config = parseRepoConfigYaml(
    await github.reader.fileAt(target, pr.baseSha, ".lgtmoose.yaml"),
  );
  const conversation = job.requested === "replies" || job.requested === "explain";
  const pull = { owner: target.owner, repo: target.repo, pull: target.number };
  // A finished check is about the head, not a PR event: on a PR that isn't open, is a draft or
  // carries the skip label, it starts nothing (the gateway checks those for PR events).
  if (
    job.kind === "pr_checks" &&
    (pr.state !== "open" || pr.draft === true || (pr.labels ?? []).includes(SKIP_LABEL))
  ) {
    await deps.runs.supersedeRun(runId);
    deps.log("not triggered", { runId, reason: "the PR isn't one to review" });
    return { mode: "skip" };
  }
  // A review someone asked for starts the automatic-review count over, including when it then
  // waits for CI. The head is remembered so the run CI releases can be left out of the count
  // without also dropping reviews that finished while it waited.
  if (job.requested === "review" || job.requested === "full_review") {
    await deps.runs.armRequestedReview(job.repo, job.prNumber, pr.headSha);
  }
  let armedHead = await deps.runs.requestedReviewHead(job.repo, job.prNumber);
  if (armedHead !== undefined && armedHead !== pr.headSha) {
    await deps.runs.forgetRequestedReview(job.repo, job.prNumber);
    armedHead = undefined;
  }
  const automaticReviews = await deps.runs.automaticReviews(job.repo, job.prNumber);
  const gate = reviewGate(
    config.review,
    job,
    { labels: pr.labels ?? [] },
    reviewedBefore,
    automaticReviews,
  );
  // Its trigger says the review may start: it may still wait for the head's CI (NIC-1078).
  const ci = gate.review
    ? await waitForChecks(deps, github, job, target, pr, runId, config)
    : undefined;
  if (gate.review && ci?.wait !== true) {
    const fulfillsRequest =
      job.requested === "review" ||
      job.requested === "full_review" ||
      (job.kind === "pr_checks" && armedHead === pr.headSha);
    if (fulfillsRequest) {
      // Leaves this run out of the count. A push on the same commit does not: that is another review.
      await deps.runs.noteRequestedRun(job.repo, job.prNumber, runId);
    }
    if (gate.removeLabel !== undefined) {
      try {
        await github.poster(runId, pull).labels(pull).removePrLabel(gate.removeLabel);
      } catch (error) {
        // The review goes ahead; the label comes off next time.
        deps.log("trigger label not removed", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return ci?.notice === undefined ? { mode: "review" } : { mode: "review", notices: [ci.notice] };
  }
  const waitMode = conversation ? "conversation" : "skip";
  if (!conversation) await deps.runs.supersedeRun(runId);
  if (gate.review) {
    // Waits for CI: `waitForChecks` posted its check run when it had something new to say.
    deps.log("not triggered", { runId, reason: "waiting for CI", conversation });
    return { mode: waitMode };
  }
  deps.log("not triggered", { runId, reason: gate.reason, waiting: gate.waiting, conversation });
  if (!gate.waiting) return { mode: waitMode };
  const check = waitingCheckRun(
    config.review,
    config.gate,
    await commandHandle(deps, github),
    reviewedBefore,
    automaticReviews,
  );
  if (check !== undefined) {
    await github.poster(runId, pull).completeCheckRun(pull, {
      headSha: pr.headSha,
      ...check,
      annotations: [],
      // A retry finds the run an earlier attempt created, instead of adding another.
      externalId: runId,
    });
  }
  return { mode: waitMode };
}

/** Permissions that let a person's review command start a review without waiting for CI. */
const SKIPS_CI_WAIT: ReadonlySet<string> = new Set(["admin", "maintain", "write"]);

/**
 * The wait for CI (`review.wait_for_checks`, NIC-1078), once the trigger says the review may
 * start. `wait` when the head's checks haven't all passed: the PR is recorded as waiting on this
 * head (so a check finishing on it asks for a run again) and its check run says what it waits
 * for, unless it already said the same. A review that starts clears the wait; one that starts
 * because the wait timed out gets a `notice` for its summary.
 *
 * A person's `review` or `full review` from someone with write access, by GitHub's
 * collaborators API, starts the review now. The PR's author without write access, or a trusted
 * bot, waits like a push. A run for replies or `explain` waits too: it only judges and explains.
 */
async function waitForChecks(
  deps: ControlDeps,
  github: RunGitHub,
  job: WorkflowJob,
  target: ReturnType<typeof jobTarget>,
  pr: PullRequest,
  runId: string,
  config: ReturnType<typeof parseRepoConfigYaml>,
): Promise<{ wait: boolean; notice?: string }> {
  const waits = deps.checksWaits;
  const { reader } = github;
  const setting = config.review.wait_for_checks;
  const clear = async () => {
    await waits?.clear(job.repo, job.prNumber);
    return { wait: false };
  };
  if (setting === "off" || waits === undefined || reader.checksAt === undefined) return clear();
  if (job.requested === "review" || job.requested === "full_review") {
    const permission = github.permission;
    const actor = job.actor;
    if (actor !== undefined && permission !== undefined) {
      try {
        if (SKIPS_CI_WAIT.has(await permission(target, actor))) {
          deps.log("CI wait skipped by a review command", { runId });
          return clear();
        }
      } catch (error) {
        // Unread: the command waits for CI like a push, rather than skip it on a guess.
        deps.log("permission unread, the review waits for CI", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const required =
    setting === "required" && reader.requiredChecks !== undefined
      ? await reader.requiredChecks(target, pr.baseRef)
      : undefined;
  const wanted = checksToWaitFor(setting, required);
  if (wanted === undefined) return clear();
  const state = checksState(wanted, await reader.checksAt(target, pr.headSha));
  const now = new Date();
  const before = await waits.get(job.repo, job.prNumber);
  const since = before?.headSha === pr.headSha ? before.since : now;
  const decision = checksGate({ settings: config.review, checks: state, since, now });
  if (decision.review) {
    await waits.clear(job.repo, job.prNumber);
    if (decision.timedOut === undefined) return { wait: false };
    deps.log("CI wait timed out", { runId, pending: decision.timedOut.pending.length });
    return { wait: false, notice: timedOutNotice(decision.timedOut) };
  }
  const said = waitState(decision.checks);
  const previous = await waits.wait(job.repo, job.prNumber, pr.headSha, said, now);
  deps.log("waiting for CI", {
    runId,
    failed: decision.checks.failed.length,
    pending: decision.checks.pending.length,
  });
  if (previous?.state === said) return { wait: true };
  const check = waitingForChecksRun(
    config.review,
    config.gate,
    await commandHandle(deps, github),
    decision.checks,
  );
  if (check !== undefined) {
    const pull = { owner: target.owner, repo: target.repo, pull: target.number };
    await github.poster(runId, pull).completeCheckRun(pull, {
      headSha: pr.headSha,
      ...check,
      annotations: [],
      externalId: runId,
    });
  }
  return { wait: true };
}

/**
 * The prepare step: records the run, clones the PR, plans it and writes each batch's input, the
 * checkout archive and the prepared review to the artifact bucket. It runs once per execution.
 */
export async function prepare(
  deps: ControlDeps,
  job: WorkflowJob,
  executionArn: string,
  settings: PrepareSettings,
): Promise<PrepareOutput> {
  const target = jobTarget(job);
  const github = await deps.github(job.installationId);
  const pr = await github.reader.pull(target);
  const run = await deps.runs.startRun({
    installationId: job.installationId,
    repo: job.repo,
    number: job.prNumber,
    author: pr.author,
    headSha: job.headSha ?? pr.headSha,
    baseSha: pr.baseSha,
    executionArn,
    ...(job.eventAt === undefined ? {} : { eventAt: new Date(job.eventAt) }),
  });
  if (job.headSha !== undefined && job.headSha !== pr.headSha) {
    // A newer push has its own execution; this one reviews nothing.
    await deps.runs.supersedeRun(run.runId);
    deps.log("superseded", { runId: run.runId, queued: job.headSha, head: pr.headSha });
    return { runId: run.runId, superseded: true, batches: [] };
  }

  const lastReviewed = run.lastReviewedSha;
  const { mode, notices } = await triggered(
    deps,
    github,
    job,
    target,
    pr,
    run.runId,
    lastReviewed !== undefined,
  );
  if (mode === "skip") return { runId: run.runId, superseded: true, batches: [] };
  const conversationOnly = mode === "conversation";

  // Spend caps (NIC-1079), for a run the trigger gate let through: a run it skipped reserves
  // nothing. A person's review command lifts the PR's own caps, when GitHub says they have write
  // access. Before the clone: a run the caps stop entirely, with nothing new to say, ends here.
  const spendAt = new Date();
  const permission = github.permission;
  const liftPr =
    deps.spend === undefined
      ? false
      : await liftsPrCaps(
          job,
          permission === undefined ? undefined : (login) => permission(target, login),
          (message, fields) => deps.log(message, fields),
        );
  if (deps.spend !== undefined) {
    const probe = planSpend({
      caps: effectiveCaps(deps.spend.budgets),
      snapshot: await deps.spend.store.snapshot(
        { repo: job.repo, prNumber: job.prNumber },
        spendAt,
      ),
      override: liftPr,
      // A conversation-only run has judge and explainer batches only: probe with one of those.
      wanted: [
        conversationOnly
          ? { index: 0, kind: "judge", tier: REPLY_JUDGE_TIER as Tier }
          : { index: 0, kind: "review", tier: "standard" },
      ],
      prices: tierPrices(deps.spend.budgets),
      now: spendAt,
    });
    if (
      probe.cap !== undefined &&
      (await quietlyCapped(deps.spend.store, run, job.requested, pr.headSha, probe.cap))
    ) {
      await deps.runs.supersedeRun(run.runId);
      deps.log("spend capped, nothing new to post", { runId: run.runId, cap: probe.cap.kind });
      return { runId: run.runId, superseded: true, batches: [] };
    }
  }

  const keys = runKeys(run.runId);
  // A full review someone asked for leaves earlier reviews out: every file is reviewed again,
  // as on a first review. Duplicates of what earlier reviews posted are still dropped. A
  // conversation-only run reviews nothing, so it picks up no earlier run's batches.
  const full = job.requested === "full_review";
  const [resumed, reviewed] = full
    ? [[], []]
    : await Promise.all([
        conversationOnly ? [] : resumableWork(deps, run.pullRequestId, run.runId),
        deps.runs.reviewedFiles(run.pullRequestId),
      ]);
  const work = await deps.workDir();
  try {
    const checkout = join(work.dir, "checkout");
    const repo = await deps.clone({
      url: deps.cloneUrl(target.owner, target.repo),
      dir: checkout,
      headSha: pr.headSha,
      // The commits files were last reviewed at, to compare their PR changes with.
      otherShas: [pr.baseSha, ...new Set(reviewed.map((file) => file.reviewedAt))],
      token: await github.token(),
    });
    const { learnings } = deps;
    const taken = await takeReplies(deps, run.pullRequestId, settings);
    const planned = await prepareReview(
      {
        github: github.reader,
        progress: (line) => deps.log(line),
        // A conversation-only run builds no reviewer prompts, so it ranks no learnings.
        ...(learnings === undefined || conversationOnly
          ? {}
          : {
              learnings: (batch) =>
                learnings({ org: target.owner, repo: `${target.owner}/${target.repo}`, ...batch }),
            }),
      },
      target,
      repo,
      pr,
      {
        reviewed,
        resumed,
        hiddenThreads: new Set([
          ...repliedThreads(taken),
          ...((await deps.findings.fixedCommentIds?.(run.pullRequestId)) ?? []),
        ]),
      },
    );
    // A conversation-only run keeps the plan (the post step reads the PR from it) but reviews
    // none of it: no review batches.
    const prepared: PreparedReview = conversationOnly ? { ...planned, jobs: [] } : planned;
    // Before the checkout is sealed: whether a finding's file changed needs its commit.
    const judges = await judgeJobs(deps, taken, repo, pr.headSha, prepared);
    // Linked tickets, read here with the provider's credential; their text goes to the sandbox
    // in the checker's prompt, the credential never does. They're part of a code review, so a
    // conversation-only run has none.
    const tickets: Awaited<ReturnType<typeof prepareTickets>> = conversationOnly
      ? { batches: [] }
      : await prepareTickets(
          deps,
          repo,
          prepared,
          Math.max(
            -1,
            ...prepared.jobs.map((batch) => batch.index),
            ...judges.map((j) => j.index),
          ) + 1,
        );
    // Findings someone asked to have explained, after the tickets' batches.
    const explains = await explainJobs(deps, {
      pullRequestId: run.pullRequestId,
      limit: settings.maxExplanations ?? 0,
      repo,
      repoName: `${target.owner}/${target.repo}`,
      prNumber: target.number,
      headSha: pr.headSha,
      firstIndex:
        Math.max(
          -1,
          ...prepared.jobs.map((batch) => batch.index),
          ...judges.map((j) => j.index),
          ...tickets.batches.map((ticket) => ticket.index),
        ) + 1,
    });
    // What the caps let run, reserved before anything is dispatched: people's replies and
    // explains first, then tickets, then the review's batches in plan order (riskiest first).
    const wanted: PlannedBatch[] = [
      ...judges.map((judge) => ({
        index: judge.index,
        kind: "judge" as const,
        tier: REPLY_JUDGE_TIER as Tier,
      })),
      ...explains.flatMap((explain) =>
        explain.index === undefined || explain.prompt === undefined
          ? []
          : [{ index: explain.index, kind: "explain" as const, tier: EXPLAINER_TIER as Tier }],
      ),
      ...tickets.batches.map((ticket) => ({
        index: ticket.index,
        kind: "ticket" as const,
        tier: TICKET_CHECKER_TIER as Tier,
      })),
      ...prepared.jobs.flatMap((batch) =>
        batch.prompt === undefined
          ? []
          : [{ index: batch.index, kind: "review" as const, tier: "standard" as Tier }],
      ),
    ];
    const spent =
      deps.spend === undefined
        ? RUN_ALL
        : await reserveSpend(
            deps.spend,
            { runId: run.runId, repo: job.repo, prNumber: job.prNumber },
            {
              caps: effectiveCaps(deps.spend.budgets, prepared.config.budgets),
              override: liftPr,
              wanted,
              now: spendAt,
            },
            (message, fields) => deps.log(message, fields),
          );
    const notRun = wanted.filter((batch) => !spent.runs(batch.index));
    if (spent.cap !== undefined && deps.spend !== undefined) {
      if (
        notRun.length === wanted.length &&
        (await quietlyCapped(deps.spend.store, run, job.requested, pr.headSha, spent.cap))
      ) {
        await deps.runs.supersedeRun(run.runId);
        deps.log("spend capped, nothing new to post", { runId: run.runId, cap: spent.cap.kind });
        return { runId: run.runId, superseded: true, batches: [] };
      }
      await deps.spend.store.markCapped(run.runId, spent.cap.kind);
    }
    const keptJudges = judges.filter((judge) => spent.runs(judge.index));
    const keptExplains = explains.filter(
      (explain) => explain.index === undefined || spent.runs(explain.index),
    );
    const ticketsManifest =
      tickets.manifest === undefined
        ? undefined
        : {
            ...tickets.manifest,
            tickets: tickets.manifest.tickets.map((ticket) => {
              if (ticket.index === undefined || spent.runs(ticket.index)) return ticket;
              const rest = { ...ticket, note: TICKET_SPEND_CAP_NOTE };
              delete rest.index;
              return rest;
            }),
          };
    const cappedReview = notRun.filter((batch) => batch.kind === "review").map((b) => b.index);

    await sealCheckout(repo, planned);
    const archive = join(work.dir, "checkout.tar.gz");
    await deps.archive(checkout, archive);
    await deps.store.putFile(keys.checkout, archive, "application/gzip");

    const batches: { index: number }[] = [];
    for (const batch of prepared.jobs) {
      if (batch.prompt === undefined || !spent.runs(batch.index)) continue;
      const input: BatchInput = batchInputSchema.parse({
        version: 1,
        runId: run.runId,
        index: batch.index,
        prompt: batch.prompt,
        ...(prepared.reviewerSystem === undefined ? {} : { system: prepared.reviewerSystem }),
        ...(prepared.reviewerShared === undefined ? {} : { shared: prepared.reviewerShared }),
        model: settings.model,
        timeoutMs: settings.batchTimeoutMs,
      });
      await deps.store.putText(keys.batchInput(batch.index), JSON.stringify(input));
      batches.push({ index: batch.index });
    }
    for (const judge of keptJudges) {
      const input: BatchInput = batchInputSchema.parse({
        version: 1,
        runId: run.runId,
        index: judge.index,
        prompt: judge.prompt,
        role: "judge",
        tier: REPLY_JUDGE_TIER,
        model: settings.model,
        timeoutMs: Math.min(settings.batchTimeoutMs, JUDGE_TIMEOUT_MS),
      });
      await deps.store.putText(keys.batchInput(judge.index), JSON.stringify(input));
      batches.push({ index: judge.index });
    }
    for (const ticket of tickets.batches) {
      if (!spent.runs(ticket.index)) continue;
      const input: BatchInput = batchInputSchema.parse({
        version: 1,
        runId: run.runId,
        index: ticket.index,
        prompt: ticket.prompt,
        role: "ticket",
        tier: TICKET_CHECKER_TIER,
        model: settings.model,
        timeoutMs: Math.min(settings.batchTimeoutMs, TICKET_TIMEOUT_MS),
      });
      await deps.store.putText(keys.batchInput(ticket.index), JSON.stringify(input));
      batches.push({ index: ticket.index });
    }
    for (const explain of keptExplains) {
      if (explain.index === undefined || explain.prompt === undefined) continue;
      const input: BatchInput = batchInputSchema.parse({
        version: 1,
        runId: run.runId,
        index: explain.index,
        prompt: explain.prompt,
        role: "explain",
        tier: EXPLAINER_TIER,
        model: settings.model,
        timeoutMs: Math.min(settings.batchTimeoutMs, EXPLAIN_TIMEOUT_MS),
      });
      await deps.store.putText(keys.batchInput(explain.index), JSON.stringify(input));
      batches.push({ index: explain.index });
    }
    const manifest: RunManifest = {
      version: MANIFEST_VERSION,
      installationId: job.installationId,
      review: prepared,
      ...(job.requested === undefined ? {} : { requested: job.requested }),
      ...(keptJudges.length === 0
        ? {}
        : { judgements: keptJudges.map(({ prompt: _, ...rest }) => rest) }),
      ...(ticketsManifest === undefined ? {} : { tickets: ticketsManifest }),
      ...(keptExplains.length === 0
        ? {}
        : { explanations: keptExplains.map(({ prompt: _, ...rest }) => rest) }),
      ...(spent.cap === undefined
        ? {}
        : {
            spendCap: {
              kind: spent.cap.kind,
              batches: cappedReview,
              reason: capReason(spent.cap, notRun.length),
            },
          }),
      ...(conversationOnly ? { conversationOnly: true as const } : {}),
      ...(notices === undefined ? {} : { notices }),
    };
    await deps.store.putText(keys.prepared, JSON.stringify(manifest));
    await deps.runs.setPlan(run.runId, {
      filesTotal: conversationOnly ? 0 : prepared.plan.files.length,
      kind: runKind(prepared, lastReviewed),
      fromSha: prepared.kind === "incremental" ? lastReviewed : undefined,
    });
    deps.log("prepared", {
      runId: run.runId,
      kind: prepared.kind,
      batches: batches.length,
      ...(conversationOnly ? { conversationOnly } : {}),
      done: prepared.done.length,
      carriedBatches: prepared.carried.length,
      carriedFindings: prepared.carried.flatMap((batch) => batch.findings).length,
      ...(prepared.fallbackReason === undefined ? {} : { fallback: prepared.fallbackReason }),
    });
    return { runId: run.runId, superseded: false, batches };
  } finally {
    await work.remove();
  }
}
