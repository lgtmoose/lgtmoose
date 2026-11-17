import {
  type DescribeExecutionCommand,
  StartExecutionCommand,
  type StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it, vi } from "vitest";
import { executionArnOf, sfnExecutions, sqsDeadLetter } from "./dispatch-aws.js";
import {
  PUSH_DEBOUNCE_SECONDS,
  dispatch,
  dispatchBatch,
  executionName,
  executionPrefix,
  type DispatchDeps,
  type DispatchJob,
  type DispatchedExecution,
  type WorkflowInput,
} from "./dispatch.js";

const SM = "arn:aws:states:eu-west-1:123456789012:stateMachine:Review";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const T1 = "2026-11-14T00:00:01.000Z";
const T2 = "2026-11-14T00:00:02.000Z";
const T3 = "2026-11-14T00:00:03.000Z";

function job(overrides: Partial<DispatchJob> = {}): DispatchJob {
  return {
    kind: "pr_updated",
    deliveryId: "d-new",
    installationId: 7,
    repo: "acme/shop",
    prNumber: 12,
    headSha: NEW,
    actor: "dev",
    receivedAt: "2026-11-14T00:01:00.000Z",
    eventAt: T2,
    ...overrides,
  };
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing");
  return value;
}

const arn = (name: string) => executionArnOf(SM, name);
const nameOf = (sha: string, retryFor?: string) => executionName("acme/shop", 12, sha, retryFor);

/**
 * A fake state machine and dispatch store. Names are unique for good, as in Step Functions,
 * and starting a running execution again with the same input returns it.
 */
function fakeDeps() {
  const executions = new Map<string, { input: WorkflowInput; status: string }>();
  const recorded = new Map<string, DispatchedExecution & { pr: string; stopped: boolean }>();
  const latest = new Map<string, { eventAt: Date; closed: boolean }>();
  /** Run status by execution ARN, as `review_runs` would have it. */
  const runs = new Map<string, string>();
  const reviewedHeads = new Set<string>();
  /** PRs whose automatic reviews are paused. */
  const pausedPrs = new Set<string>();
  /** Jobs forwarded to the conversation queue. */
  const forwarded: string[] = [];
  /** Our findings' status by their inline comment's ID, as `findings` would have it. */
  const threadFindings = new Map<number, string>();
  const calls: string[] = [];
  const deadLettered: { messageId: string; reason: string }[] = [];
  /** Repositories whose jobs fail as if the database were down. */
  const failing = new Set<string>();
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const pr = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;
  const deps: DispatchDeps = {
    executions: {
      arnOf: arn,
      async start(name, input) {
        calls.push(`start ${name}`);
        const existing = executions.get(name);
        if (existing === undefined) {
          executions.set(name, { input, status: "RUNNING" });
          return { started: true };
        }
        const same = JSON.stringify(existing.input) === JSON.stringify(input);
        return { started: existing.status === "RUNNING" && same };
      },
      async status(executionArn) {
        return executions.get(executionArn.slice(executionArn.lastIndexOf(":") + 1))?.status;
      },
      async stop(executionArn) {
        calls.push(`stop ${executionArn}`);
        const execution = executions.get(executionArn.slice(executionArn.lastIndexOf(":") + 1));
        if (execution?.status === "RUNNING") execution.status = "ABORTED";
      },
    },
    store: {
      async latest(repo, n) {
        if (failing.has(repo)) throw new Error("database unavailable");
        return latest.get(pr(repo, n));
      },
      async advance(repo, n, eventAt, closed) {
        latest.set(pr(repo, n), { eventAt, closed });
      },
      async record(repo, n, execution) {
        if (!recorded.has(execution.executionArn)) {
          recorded.set(execution.executionArn, { ...execution, pr: pr(repo, n), stopped: false });
        }
      },
      async unstopped(repo, n) {
        return [...recorded.values()]
          .filter((r) => r.pr === pr(repo, n) && !r.stopped)
          .map(({ executionArn, headSha, eventAt }) => ({ executionArn, headSha, eventAt }));
      },
      async supersedeRun(executionArn) {
        calls.push(`supersede ${executionArn}`);
        if (runs.get(executionArn) === "running") runs.set(executionArn, "superseded");
      },
      async markStopped(executionArn) {
        calls.push(`marked ${executionArn}`);
        const row = recorded.get(executionArn);
        if (row) row.stopped = true;
      },
      async reviewed(_repo, _n, headSha) {
        return reviewedHeads.has(headSha);
      },
      async paused(repo, n) {
        return pausedPrs.has(pr(repo, n));
      },
      async followThread(_repo, _n, commentId, resolved, actor) {
        calls.push(`thread ${commentId} ${resolved ? "resolved" : "unresolved"} by ${actor}`);
        const status = threadFindings.get(commentId);
        if (resolved && status === "open (blocking)") return { changed: 0, held: 1 };
        if (resolved && (status === "open" || status === "outdated")) {
          threadFindings.set(commentId, "resolved_by_human");
          return { changed: 1, held: 0 };
        }
        if (!resolved && status === "resolved_by_human") {
          threadFindings.set(commentId, "open");
          return { changed: 1, held: 0 };
        }
        return { changed: 0, held: 0 };
      },
    },
    async deadLetter(record, reason) {
      deadLettered.push({ messageId: record.messageId, reason });
    },
    conversation: {
      async send(job) {
        forwarded.push(job.deliveryId);
      },
    },
    log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
  };
  const status = (name: string) => executions.get(name)?.status;
  return {
    deps,
    executions,
    recorded,
    runs,
    reviewedHeads,
    pausedPrs,
    forwarded,
    threadFindings,
    calls,
    logs,
    status,
    deadLettered,
    failing,
  };
}

describe("executionName", () => {
  it("names the execution after the repository, the PR and the head", () => {
    const name = executionName("Acme/Shop", 12, NEW);
    expect(name).toMatch(/^acme_shop-[0-9a-f]{12}-12-b{40}$/);
    // No dots: Step Functions advises against them in names with CloudWatch logging.
    expect(executionName("acme/shop.js", 12, NEW)).toMatch(/^acme_shop-js-[0-9a-f]{12}-12-/);
    expect(name).toBe(executionName("acme/shop", 12, NEW));
  });

  it("fits Step Functions' limits for long names, SHA-256 heads and retries", () => {
    const repo = `${"o".repeat(39)}/${"r".repeat(100)}`;
    const name = executionName(repo, 2_147_483_647, "c".repeat(64));
    expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(name.endsWith(`-2147483647-${"c".repeat(40)}`)).toBe(true);
    const retry = executionName(repo, 2_147_483_647, "c".repeat(64), "delivery");
    expect(retry.length).toBeLessThanOrEqual(80);
    expect(retry).toMatch(new RegExp(`^${name}-[0-9a-f]{8}$`));
  });

  it("keeps repositories apart whose names only differ in the owner/name split", () => {
    expect(executionPrefix("a-b/c", 1)).not.toBe(executionPrefix("a/b-c", 1));
    expect(executionPrefix("a_b/c", 1)).not.toBe(executionPrefix("a/b_c", 1));
    expect(executionPrefix("a/b.c", 1)).not.toBe(executionPrefix("a/b-c", 1));
  });
});

describe("dispatch", () => {
  it("records and starts a push's review with the debounce wait and its job as input", async () => {
    const f = fakeDeps();
    const result = await dispatch(f.deps, job());
    expect(result).toEqual({ action: "started", executionArn: arn(nameOf(NEW)), stopped: [] });
    expect(f.executions.get(nameOf(NEW))?.input).toEqual({
      ...job(),
      debounceSeconds: PUSH_DEBOUNCE_SECONDS,
    });
    expect(f.recorded.get(arn(nameOf(NEW)))).toMatchObject({ headSha: NEW, eventAt: new Date(T2) });
  });

  it("starts an opened or ready PR's review at once", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened", headSha: OLD, eventAt: T1 }));
    await dispatch(f.deps, job({ kind: "pr_ready" }));
    expect(f.executions.get(nameOf(OLD))?.input.debounceSeconds).toBe(0);
    expect(f.executions.get(nameOf(NEW))?.input.debounceSeconds).toBe(0);
  });

  it("stops older jobs' executions, marking each run superseded before the stop", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ headSha: OLD, eventAt: T1, deliveryId: "d-old" }));
    f.runs.set(arn(nameOf(OLD)), "running");
    await dispatch(f.deps, job({ kind: "pr_opened", repo: "acme/other", eventAt: T1 }));
    f.calls.length = 0;
    const result = await dispatch(f.deps, job());
    expect(result).toEqual({
      action: "started",
      executionArn: arn(nameOf(NEW)),
      stopped: [arn(nameOf(OLD))],
    });
    expect(f.calls).toEqual([
      `start ${nameOf(NEW)}`,
      `supersede ${arn(nameOf(OLD))}`,
      `stop ${arn(nameOf(OLD))}`,
      `marked ${arn(nameOf(OLD))}`,
    ]);
    expect(f.runs.get(arn(nameOf(OLD)))).toBe("superseded");
    // Other PRs' executions keep running.
    expect(f.executions.get(executionName("acme/other", 12, NEW))?.status).toBe("RUNNING");
  });

  it("does nothing for a push older than the PR's newest, even one GitHub sent late", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job());
    const result = await dispatch(f.deps, job({ headSha: OLD, eventAt: T1, deliveryId: "d-old" }));
    expect(result).toMatchObject({ action: "stale" });
    expect(f.status(nameOf(NEW))).toBe("RUNNING");
    expect(f.executions.has(nameOf(OLD))).toBe(false);
  });

  it("ignores an old push redelivered while its own execution still runs", async () => {
    const f = fakeDeps();
    const old = job({ headSha: OLD, eventAt: T1, deliveryId: "d-old" });
    await dispatch(f.deps, old);
    await dispatch(f.deps, job());
    // Say the stop hasn't taken yet: starting the old one again with the same input would
    // "succeed", as Step Functions returns a running execution.
    must(f.executions.get(nameOf(OLD))).status = "RUNNING";
    expect(await dispatch(f.deps, old)).toMatchObject({ action: "stale" });
    expect(f.status(nameOf(NEW))).toBe("RUNNING");
  });

  it("does nothing for an open that arrives after a later push", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job());
    const opened = job({ kind: "pr_opened", headSha: OLD, eventAt: T1, deliveryId: "d-open" });
    expect(await dispatch(f.deps, opened)).toMatchObject({ action: "stale" });
    expect(f.status(nameOf(NEW))).toBe("RUNNING");
  });

  it("runs both jobs of the same second: prepare tells them apart by the real head", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ headSha: OLD, deliveryId: "d-old" }));
    const result = await dispatch(f.deps, job());
    expect(result).toMatchObject({ action: "started", stopped: [] });
    expect(f.status(nameOf(OLD))).toBe("RUNNING");
  });

  it("stops older executions in parallel, and finishes the others when one fails", async () => {
    const f = fakeDeps();
    const shas = ["1", "2", "3"].map((c) => c.repeat(40));
    for (const [i, sha] of shas.entries()) {
      await dispatch(f.deps, job({ headSha: sha, eventAt: T1, deliveryId: `d-${i}` }));
    }
    const { executions } = f.deps;
    const real = { ...executions };
    let inFlight = 0;
    let most = 0;
    executions.stop = async (executionArn, cause) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (executionArn === arn(nameOf(shas[1] ?? ""))) throw new Error("throttled");
      await real.stop(executionArn, cause);
    };
    await expect(dispatch(f.deps, job())).rejects.toThrow("throttled");
    expect(most).toBe(3);
    expect(f.status(nameOf(shas[0] ?? ""))).toBe("ABORTED");
    expect(f.status(nameOf(shas[2] ?? ""))).toBe("ABORTED");
    expect(f.recorded.get(arn(nameOf(shas[1] ?? "")))?.stopped).toBe(false);
  });

  it("supersedes again when the same message is retried after a failed stop", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ headSha: OLD, eventAt: T1, deliveryId: "d-old" }));
    f.runs.set(arn(nameOf(OLD)), "running");
    const { executions } = f.deps;
    const real = { ...executions };
    let fail = true;
    executions.stop = async (executionArn, cause) => {
      if (fail) throw new Error("throttled");
      await real.stop(executionArn, cause);
    };
    await expect(dispatch(f.deps, job())).rejects.toThrow("throttled");
    // The run was marked before the stop; the execution wasn't marked stopped.
    expect(f.runs.get(arn(nameOf(OLD)))).toBe("superseded");
    expect(f.recorded.get(arn(nameOf(OLD)))?.stopped).toBe(false);
    fail = false;
    expect(await dispatch(f.deps, job())).toMatchObject({ stopped: [arn(nameOf(OLD))] });
    expect(f.status(nameOf(OLD))).toBe("ABORTED");
  });

  it("stops every execution of a closed PR, and ignores pushes from before the close", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job());
    const closed = job({ kind: "pr_closed", eventAt: T2, deliveryId: "d-close" });
    expect(await dispatch(f.deps, closed)).toEqual({
      action: "stopped",
      stopped: [arn(nameOf(NEW))],
    });
    expect(f.status(nameOf(NEW))).toBe("ABORTED");
    const late = job({ headSha: OLD, eventAt: T1, deliveryId: "d-late" });
    expect(await dispatch(f.deps, late)).toMatchObject({ action: "stale" });
    // A reopen in the same second as the close is taken as before it.
    const tie = job({ kind: "pr_opened", eventAt: T2, deliveryId: "d-tie" });
    expect(await dispatch(f.deps, tie)).toMatchObject({ action: "stale" });
  });

  it("keeps a reopened PR's review when the close arrives after the reopen", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened", eventAt: T3, deliveryId: "d-reopen" }));
    const close = job({ kind: "pr_closed", eventAt: T2, deliveryId: "d-close" });
    expect(await dispatch(f.deps, close)).toMatchObject({ action: "stale" });
    expect(f.status(nameOf(NEW))).toBe("RUNNING");
  });

  it("reviews a PR reopened at the head its close stopped, once per delivery", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened", eventAt: T1, deliveryId: "d-open" }));
    await dispatch(f.deps, job({ kind: "pr_closed", eventAt: T2, deliveryId: "d-close" }));
    const reopened = job({ kind: "pr_opened", eventAt: T3, deliveryId: "d-reopen" });
    const retry = nameOf(NEW, "d-reopen");
    expect(await dispatch(f.deps, reopened)).toEqual({
      action: "retried",
      executionArn: arn(retry),
      stopped: [],
    });
    expect(f.status(retry)).toBe("RUNNING");
    expect(retry.startsWith(executionPrefix("acme/shop", 12))).toBe(true);

    // The same delivery again, once its retry has ended: a duplicate.
    must(f.executions.get(retry)).status = "FAILED";
    expect(await dispatch(f.deps, reopened)).toMatchObject({ action: "duplicate", name: retry });
  });

  it("doesn't start a second retry while the first still runs", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened", eventAt: T1, deliveryId: "d-open" }));
    await dispatch(f.deps, job({ kind: "pr_closed", eventAt: T2, deliveryId: "d-close" }));
    await dispatch(f.deps, job({ kind: "pr_opened", eventAt: T3, deliveryId: "d-reopen" }));
    const ready = job({
      kind: "pr_ready",
      eventAt: "2026-11-14T00:00:04.000Z",
      deliveryId: "d-ready",
    });
    expect(await dispatch(f.deps, ready)).toMatchObject({ action: "duplicate", stopped: [] });
    expect(f.status(nameOf(NEW, "d-reopen"))).toBe("RUNNING");
    expect(f.executions.has(nameOf(NEW, "d-ready"))).toBe(false);
  });

  it("doesn't retry a head that a run reviewed, or one still running", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened", eventAt: T1, deliveryId: "d-open" }));
    await dispatch(f.deps, job({ kind: "pr_closed", eventAt: T2, deliveryId: "d-close" }));
    // An earlier reopen's retry posted the review for this head.
    f.reviewedHeads.add(NEW);
    const again = job({ kind: "pr_ready", eventAt: T3, deliveryId: "d-ready" });
    expect(await dispatch(f.deps, again)).toMatchObject({ action: "duplicate" });
    expect(f.executions.size).toBe(1);
    // A second job for a head whose execution still runs is a duplicate too.
    const g = fakeDeps();
    await dispatch(g.deps, job({ kind: "pr_opened", eventAt: T1, deliveryId: "d-open" }));
    const ready = job({ kind: "pr_ready", eventAt: T3, deliveryId: "d-ready" });
    expect(await dispatch(g.deps, ready)).toMatchObject({ action: "duplicate", stopped: [] });
    expect(g.status(nameOf(NEW))).toBe("RUNNING");
  });

  it("reviews a head again after a force-push back to it, when a later push stopped it", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ headSha: OLD, eventAt: T1, deliveryId: "d-1" }));
    await dispatch(f.deps, job({ eventAt: T2, deliveryId: "d-2" }));
    const back = job({ headSha: OLD, eventAt: T3, deliveryId: "d-3" });
    const retry = nameOf(OLD, "d-3");
    expect(await dispatch(f.deps, back)).toEqual({
      action: "retried",
      executionArn: arn(retry),
      stopped: [arn(nameOf(NEW))],
    });
    expect(f.status(retry)).toBe("RUNNING");
    expect(f.status(nameOf(NEW))).toBe("ABORTED");
  });

  it("forwards comment jobs and submitted reviews to the conversation queue", async () => {
    const f = fakeDeps();
    const comment = job({ kind: "comment", commentId: 3, deliveryId: "c-1" });
    expect(await dispatch(f.deps, comment)).toEqual({ action: "forwarded" });
    const inline = job({ kind: "review_comment", commentId: 4, deliveryId: "c-2" });
    expect(await dispatch(f.deps, inline)).toEqual({ action: "forwarded" });
    // A review goes under its review ID, so two deliveries of it dedupe on the queue.
    const review = job({ kind: "review", reviewId: 5, deliveryId: "r-1" });
    expect(await dispatch(f.deps, review)).toEqual({ action: "forwarded" });
    expect(await dispatch(f.deps, { ...review, deliveryId: "r-2" })).toEqual({
      action: "forwarded",
    });
    expect(f.forwarded).toEqual(["c-1", "c-2", "review-5", "review-5"]);
    expect(await dispatch(f.deps, job({ kind: "review" }))).toMatchObject({ action: "ignored" });
    // Without a conversation queue, comments are dropped as before.
    const withoutQueue: DispatchDeps = { ...f.deps };
    delete withoutQueue.conversation;
    expect(await dispatch(withoutQueue, comment)).toMatchObject({ action: "deferred" });
    expect(f.executions.size).toBe(0);
  });

  it("ignores a push without a head", async () => {
    const f = fakeDeps();
    const headless = job();
    delete headless.headSha;
    expect(await dispatch(f.deps, headless)).toEqual({ action: "ignored", reason: "no head SHA" });
    expect(f.executions.size).toBe(0);
  });
});

describe("dispatch: pause and requested reviews", () => {
  it("starts no automatic review on a paused PR, but keeps its event time", async () => {
    const f = fakeDeps();
    f.pausedPrs.add("acme/shop#12");
    expect(await dispatch(f.deps, job())).toEqual({ action: "paused" });
    expect(f.executions.size).toBe(0);
    // An older push stays stale: the paused one still advanced the PR's event time.
    const older = job({ headSha: OLD, eventAt: T1 });
    expect(await dispatch(f.deps, older)).toMatchObject({ action: "stale" });
  });

  it("runs a review a person asked for on a paused PR, at once", async () => {
    const f = fakeDeps();
    f.pausedPrs.add("acme/shop#12");
    const asked = job({ requested: "review", deliveryId: "command-7-review" });
    expect(await dispatch(f.deps, asked)).toMatchObject({ action: "started" });
    expect(f.executions.get(nameOf(NEW))?.input.debounceSeconds).toBe(0);
  });

  it("uses the deployment's push wait, and none for a label", async () => {
    const f = fakeDeps();
    f.deps.pushDebounceSeconds = 300;
    await dispatch(f.deps, job({ headSha: OLD, eventAt: T1 }));
    expect(f.executions.get(nameOf(OLD))?.input.debounceSeconds).toBe(300);
    await dispatch(f.deps, job({ kind: "pr_labeled", label: "lgtmoose:review" }));
    expect(f.executions.get(nameOf(NEW))?.input).toMatchObject({
      kind: "pr_labeled",
      label: "lgtmoose:review",
      debounceSeconds: 0,
    });
  });

  it("drops a bot's label on a reviewed head (our own status labels) before anything else", async () => {
    const f = fakeDeps();
    f.reviewedHeads.add(NEW);
    const ours = job({
      kind: "pr_labeled",
      label: "Approved",
      actor: "moose[bot]",
      botActor: true,
    });
    expect(await dispatch(f.deps, ours)).toEqual({
      action: "ignored",
      reason: "a bot's label on a reviewed head",
    });
    expect(f.calls).toEqual([]);
    expect(f.executions.size).toBe(0);
    expect(f.recorded.size).toBe(0);
    // A person's label on that head still goes through, as a duplicate.
    const person = job({ kind: "pr_labeled", label: "lgtmoose:review", deliveryId: "d-person" });
    expect(await dispatch(f.deps, person)).toMatchObject({ action: "started" });
  });

  it("starts a label's run on a paused PR: the repo's trigger decides in the prepare step", async () => {
    const f = fakeDeps();
    f.pausedPrs.add("acme/shop#12");
    const labelled = job({ kind: "pr_labeled", label: "lgtmoose:review" });
    expect(await dispatch(f.deps, labelled)).toMatchObject({ action: "started" });
  });

  it("starts a label's run again for a head whose run waited, and not for a reviewed one", async () => {
    const f = fakeDeps();
    // The push's run waited for the label: its execution ended, and nothing was reviewed.
    await dispatch(f.deps, job({ eventAt: T1 }));
    must(f.executions.get(nameOf(NEW))).status = "SUCCEEDED";
    const labelled = job({ kind: "pr_labeled", label: "lgtmoose:review", deliveryId: "d-label" });
    expect(await dispatch(f.deps, labelled)).toMatchObject({
      action: "retried",
      executionArn: arn(nameOf(NEW, "d-label")),
    });
    // Once the head is reviewed, a label added again is a duplicate.
    must(f.executions.get(nameOf(NEW, "d-label"))).status = "SUCCEEDED";
    f.reviewedHeads.add(NEW);
    const again = job({
      kind: "pr_labeled",
      label: "lgtmoose:review",
      deliveryId: "d-label-2",
      eventAt: T3,
    });
    expect(await dispatch(f.deps, again)).toMatchObject({ action: "duplicate" });
  });

  it("starts a full review of a reviewed head, once per request", async () => {
    const f = fakeDeps();
    f.reviewedHeads.add(NEW);
    expect(await dispatch(f.deps, job())).toMatchObject({ action: "started" });
    must(f.executions.get(nameOf(NEW))).status = "SUCCEEDED";
    const full = job({ requested: "full_review", deliveryId: "command-8-full" });
    expect(await dispatch(f.deps, full)).toMatchObject({
      action: "retried",
      executionArn: arn(nameOf(NEW, "command-8-full")),
    });
    expect(f.executions.get(nameOf(NEW, "command-8-full"))?.input.requested).toBe("full_review");
    // The same request again (a redelivery) starts nothing new: the execution has its name.
    await dispatch(f.deps, full);
    expect(f.executions.size).toBe(2);
    must(f.executions.get(nameOf(NEW, "command-8-full"))).status = "SUCCEEDED";
    expect(await dispatch(f.deps, full)).toMatchObject({ action: "duplicate" });
    expect(f.executions.size).toBe(2);
  });

  it("starts a run for replies at a reviewed head, but not on a paused PR", async () => {
    const f = fakeDeps();
    f.reviewedHeads.add(NEW);
    expect(await dispatch(f.deps, job())).toMatchObject({ action: "started" });
    must(f.executions.get(nameOf(NEW))).status = "SUCCEEDED";
    const replies = job({ requested: "replies", deliveryId: "replies-501" });
    expect(await dispatch(f.deps, replies)).toMatchObject({
      action: "retried",
      executionArn: arn(nameOf(NEW, "replies-501")),
    });
    expect(f.executions.get(nameOf(NEW, "replies-501"))?.input.requested).toBe("replies");

    const paused = fakeDeps();
    paused.pausedPrs.add("acme/shop#12");
    expect(await dispatch(paused.deps, replies)).toEqual({ action: "paused" });
    expect(paused.executions.size).toBe(0);
  });

  it("starts a run for an explain at a reviewed head, on a paused PR too", async () => {
    const f = fakeDeps();
    f.reviewedHeads.add(NEW);
    f.pausedPrs.add("acme/shop#12");
    const explain = job({ requested: "explain", deliveryId: "explain-901" });
    expect(await dispatch(f.deps, explain)).toMatchObject({
      executionArn: arn(nameOf(NEW, "explain-901")),
    });
    expect(f.executions.get(nameOf(NEW, "explain-901"))?.input.requested).toBe("explain");
  });

  it("doesn't start a full review while a review of the head is running", async () => {
    const f = fakeDeps();
    expect(await dispatch(f.deps, job())).toMatchObject({ action: "started" });
    const full = job({ requested: "full_review", deliveryId: "command-9-full" });
    expect(await dispatch(f.deps, full)).toMatchObject({ action: "duplicate" });
    expect(f.executions.has(nameOf(NEW, "command-9-full"))).toBe(false);
  });
});

describe("dispatch: review threads", () => {
  it("resolves the finding behind a thread a person resolved, without a review", async () => {
    const f = fakeDeps();
    f.threadFindings.set(900, "open");
    const resolved = job({ kind: "thread_resolved", commentId: 900, threadNodeId: "PRRT_1" });
    expect(await dispatch(f.deps, resolved)).toEqual({
      action: "resolved",
      changed: 1,
      held: 0,
    });
    expect(f.threadFindings.get(900)).toBe("resolved_by_human");
    expect(f.calls).toContain("thread 900 resolved by dev");
    expect(f.executions.size).toBe(0);
  });

  it("passes on a resolution the store holds: the finding stays open", async () => {
    const f = fakeDeps();
    f.threadFindings.set(902, "open (blocking)");
    expect(await dispatch(f.deps, job({ kind: "thread_resolved", commentId: 902 }))).toEqual({
      action: "resolved",
      changed: 0,
      held: 1,
    });
    expect(f.threadFindings.get(902)).toBe("open (blocking)");
  });

  it("follows a person unresolving it again: the person's latest action wins", async () => {
    const f = fakeDeps();
    f.threadFindings.set(900, "resolved_by_human");
    const unresolved = job({ kind: "thread_unresolved", commentId: 900 });
    expect(await dispatch(f.deps, unresolved)).toEqual({
      action: "unresolved",
      changed: 1,
      held: 0,
    });
    expect(f.threadFindings.get(900)).toBe("open");
  });

  it("ignores threads that aren't ours, and events without the first comment", async () => {
    const f = fakeDeps();
    expect(await dispatch(f.deps, job({ kind: "thread_resolved", commentId: 1 }))).toEqual({
      action: "ignored",
      reason: "not a thread of one of our open findings",
    });
    expect(await dispatch(f.deps, job({ kind: "thread_resolved" }))).toMatchObject({
      action: "ignored",
    });
    expect(f.executions.size).toBe(0);
  });

  it("leaves a declined finding alone when its thread is unresolved", async () => {
    const f = fakeDeps();
    f.threadFindings.set(901, "declined");
    expect(
      await dispatch(f.deps, job({ kind: "thread_unresolved", commentId: 901 })),
    ).toMatchObject({ action: "ignored" });
    expect(f.threadFindings.get(901)).toBe("declined");
  });
});

describe("dispatchBatch", () => {
  const record = (messageId: string, group: string | undefined, body: unknown) => ({
    messageId,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(group === undefined ? {} : { attributes: { MessageGroupId: group } }),
  });

  it("handles every message and reports no failures", async () => {
    const f = fakeDeps();
    const result = await dispatchBatch(f.deps, [
      record("m1", "pr", job({ headSha: OLD, eventAt: T1 })),
      record("m2", "pr", job({ deliveryId: "d-2" })),
    ]);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(f.status(nameOf(OLD))).toBe("ABORTED");
  });

  it("holds back the rest of a failed message's group, and only that group", async () => {
    const f = fakeDeps();
    f.failing.add("acme/down");
    const result = await dispatchBatch(f.deps, [
      record("m1", "a", job()),
      record("m2", "b", job({ repo: "acme/down" })),
      record("m3", "a", job({ eventAt: T3, headSha: OLD })),
      record("m4", "b", job({ repo: "acme/other" })),
      record("m5", "c", job({ repo: "acme/third" })),
    ]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m2" }, { itemIdentifier: "m4" }]);
    expect(f.executions.has(executionName("acme/third", 12, NEW))).toBe(true);
    expect(f.executions.has(executionName("acme/other", 12, NEW))).toBe(false);
    expect(f.logs.find((l) => l.message === "dispatch failed")?.fields).toMatchObject({
      messageId: "m2",
      error: "database unavailable",
    });
  });

  it("holds back everything after a failed message without a group", async () => {
    const f = fakeDeps();
    f.failing.add("acme/down");
    const result = await dispatchBatch(f.deps, [
      record("m1", undefined, job({ repo: "acme/down" })),
      record("m2", "a", job()),
    ]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
  });

  it("dead-letters a job without an event time: it can't be ordered", async () => {
    const f = fakeDeps();
    const untimed: Partial<DispatchJob> = job();
    delete untimed.eventAt;
    const result = await dispatchBatch(f.deps, [record("m1", "a", untimed)]);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(f.deadLettered).toEqual([
      { messageId: "m1", reason: expect.stringContaining("eventAt") },
    ]);
    expect(f.executions.size).toBe(0);
  });

  it("dead-letters a message that isn't a job and goes on with its group", async () => {
    const f = fakeDeps();
    const result = await dispatchBatch(f.deps, [
      record("m1", "a", "not json"),
      record("m2", "a", job()),
    ]);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(f.deadLettered).toEqual([{ messageId: "m1", reason: "The message isn't JSON." }]);
    expect(f.status(nameOf(NEW))).toBe("RUNNING");
  });

  it("fails the message when it can't be dead-lettered", async () => {
    const f = fakeDeps();
    f.deps.deadLetter = async () => {
      throw new Error("sqs down");
    };
    const result = await dispatchBatch(f.deps, [record("m1", "a", "{}"), record("m2", "a", job())]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
  });

  it("names a bad job's fields without quoting their values", async () => {
    const f = fakeDeps();
    await dispatchBatch(f.deps, [
      record("m1", "a", { ...job(), repo: "secret value", prNumber: -1 }),
    ]);
    const reason = f.deadLettered[0]?.reason ?? "";
    expect(reason).toContain("repo");
    expect(reason).toContain("prNumber");
    expect(reason).not.toContain("secret value");
  });
});

describe("sfnExecutions", () => {
  function client(reply: (command: unknown) => unknown) {
    return { send: vi.fn(async (command: unknown) => reply(command)) };
  }
  const named = (name: string) => Object.assign(new Error(name), { name });

  it("starts with the input as JSON, and reports an existing name as not started", async () => {
    const c = client((command) => {
      if (command instanceof StartExecutionCommand && command.input.name === "dup") {
        throw named("ExecutionAlreadyExists");
      }
      return { executionArn: "arn:new" };
    });
    const executions = sfnExecutions(c, SM);
    const input = { ...job(), debounceSeconds: 60 };
    expect(await executions.start("n", input)).toEqual({ started: true });
    const sent = c.send.mock.calls[0]?.[0] as StartExecutionCommand | undefined;
    expect(sent?.input).toEqual({ stateMachineArn: SM, name: "n", input: JSON.stringify(input) });
    expect(await executions.start("dup", input)).toEqual({ started: false });
    expect(executions.arnOf("dup")).toBe(
      "arn:aws:states:eu-west-1:123456789012:execution:Review:dup",
    );
  });

  it("rethrows other start errors", async () => {
    const executions = sfnExecutions(
      client(() => {
        throw named("ThrottlingException");
      }),
      SM,
    );
    await expect(executions.start("n", { ...job(), debounceSeconds: 0 })).rejects.toThrow();
  });

  it("reads an execution's status, and undefined when there's none", async () => {
    const c = client((command) => {
      const executionArn = (command as DescribeExecutionCommand).input.executionArn;
      if (executionArn?.endsWith(":gone")) throw named("ExecutionDoesNotExist");
      return { status: "ABORTED" };
    });
    const executions = sfnExecutions(c, SM);
    expect(await executions.status(arn("n"))).toBe("ABORTED");
    expect(await executions.status(arn("gone"))).toBeUndefined();
    const sent = c.send.mock.calls[0]?.[0] as DescribeExecutionCommand | undefined;
    expect(sent?.input.executionArn).toBe(arn("n"));
  });

  it("stops with a cause; an execution that ended or never started is fine", async () => {
    const statuses: Record<string, string> = { "arn:done": "SUCCEEDED", "arn:busy": "RUNNING" };
    const c = client((command) => {
      const input = (command as StopExecutionCommand).input;
      if ("cause" in input) {
        if (input.executionArn === "arn:1") return {};
        throw named("ValidationException");
      }
      const status = statuses[input.executionArn ?? ""];
      if (status === undefined) throw named("ExecutionDoesNotExist");
      return { status };
    });
    const executions = sfnExecutions(c, SM);
    await executions.stop("arn:1", "why");
    expect((c.send.mock.calls[0]?.[0] as StopExecutionCommand | undefined)?.input).toEqual({
      executionArn: "arn:1",
      cause: "why",
    });
    await executions.stop("arn:done", "why");
    await executions.stop("arn:never", "why");
    await expect(executions.stop("arn:busy", "why")).rejects.toThrow("ValidationException");
  });
});

describe("sqsDeadLetter", () => {
  it("sends the body to the dead-letter queue in its group, deduped by message ID", async () => {
    const send = vi.fn(async (_command: SendMessageCommand) => ({}));
    await sqsDeadLetter({ send }, "https://sqs/dlq")(
      { messageId: "m1", body: "junk", attributes: { MessageGroupId: "acme/shop#12" } },
      "The message isn't JSON.",
    );
    await sqsDeadLetter({ send }, "https://sqs/dlq")({ messageId: "m2", body: "junk" }, "why");
    expect(send.mock.calls[0]?.[0].input).toEqual({
      QueueUrl: "https://sqs/dlq",
      MessageBody: "junk",
      MessageGroupId: "acme/shop#12",
      MessageDeduplicationId: "m1",
      MessageAttributes: { reason: { DataType: "String", StringValue: "The message isn't JSON." } },
    });
    expect(send.mock.calls[1]?.[0].input.MessageGroupId).toBe("invalid");
  });
});

describe("dispatch: checks finishing (NIC-1078)", () => {
  const checks = (overrides: Partial<DispatchJob> = {}) =>
    job({ kind: "pr_checks", deliveryId: "d-check", eventAt: T3, actor: "ci[bot]", ...overrides });

  function waitingOn(f: ReturnType<typeof fakeDeps>, headSha: string | undefined) {
    f.deps.checksWaits = {
      get: async () =>
        headSha === undefined ? undefined : { headSha, since: new Date(T1), state: "pending" },
    };
  }

  it("starts nothing for a PR that doesn't wait for CI, or waits on another head", async () => {
    for (const head of [undefined, OLD]) {
      const f = fakeDeps();
      waitingOn(f, head);
      await dispatch(f.deps, job());
      const before = f.executions.size;
      expect(await dispatch(f.deps, checks())).toMatchObject({ action: "ignored" });
      expect(f.executions.size).toBe(before);
    }
    // And without the store at all.
    const f = fakeDeps();
    expect(await dispatch(f.deps, checks())).toMatchObject({ action: "ignored" });
  });

  it("starts a run for the waiting head at the PR's own event time, stopping and advancing nothing", async () => {
    const f = fakeDeps();
    waitingOn(f, NEW);
    await dispatch(f.deps, job());
    // The push's run ended: it waited for CI.
    must(f.executions.get(nameOf(NEW))).status = "SUCCEEDED";
    expect(await dispatch(f.deps, checks())).toMatchObject({ action: "retried", stopped: [] });
    const started = must(f.executions.get(nameOf(NEW, "d-check")));
    expect(started.input).toMatchObject({ kind: "pr_checks", eventAt: T2, debounceSeconds: 20 });
    // The check's own time didn't advance the PR: a push at the PR's time isn't made stale.
    const next = job({ headSha: OLD, eventAt: T2, deliveryId: "d-next" });
    expect(await dispatch(f.deps, next)).not.toMatchObject({ action: "stale" });
  });

  it("starts none while a run for the head is running: that one reads the checks after its wait", async () => {
    const f = fakeDeps();
    waitingOn(f, NEW);
    await dispatch(f.deps, job());
    expect(await dispatch(f.deps, checks())).toMatchObject({ action: "duplicate" });
    expect(f.calls.filter((call) => call.startsWith("stop"))).toEqual([]);
  });

  it("starts nothing for a reviewed head, a paused PR or a closed one", async () => {
    const reviewed = fakeDeps();
    waitingOn(reviewed, NEW);
    await dispatch(reviewed.deps, job());
    must(reviewed.executions.get(nameOf(NEW))).status = "SUCCEEDED";
    reviewed.reviewedHeads.add(NEW);
    expect(await dispatch(reviewed.deps, checks())).toMatchObject({ action: "ignored" });

    const paused = fakeDeps();
    waitingOn(paused, NEW);
    await dispatch(paused.deps, job());
    paused.pausedPrs.add("acme/shop#12");
    expect(await dispatch(paused.deps, checks())).toEqual({ action: "paused" });

    const closed = fakeDeps();
    waitingOn(closed, NEW);
    await dispatch(closed.deps, job({ kind: "pr_closed" }));
    expect(await dispatch(closed.deps, checks())).toMatchObject({ action: "ignored" });
  });
});

describe("dispatch: commit statuses (NIC-1088)", () => {
  const status = {
    kind: "commit_status" as const,
    deliveryId: "d-status",
    installationId: 7,
    repo: "acme/shop",
    sha: NEW,
    receivedAt: T3,
  };

  it("starts nothing when no pull request waits on the commit", async () => {
    const f = fakeDeps();
    f.deps.checksWaits = { get: async () => undefined, byHead: async () => [] };
    expect(await dispatch(f.deps, status)).toMatchObject({ action: "ignored" });
    expect(f.executions.size).toBe(0);
  });

  it("runs the check path for every pull request waiting on the commit", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ prNumber: 12 }));
    await dispatch(f.deps, job({ prNumber: 13, deliveryId: "d-13" }));
    must(f.executions.get(executionName("acme/shop", 12, NEW))).status = "SUCCEEDED";
    must(f.executions.get(executionName("acme/shop", 13, NEW))).status = "SUCCEEDED";
    const before = f.executions.size;
    f.deps.checksWaits = {
      get: async (_repo, number) =>
        number === 12 || number === 13
          ? { headSha: NEW, since: new Date(T1), state: "pending" }
          : undefined,
      byHead: async () => [13, 12],
    };
    expect(await dispatch(f.deps, status)).toEqual({ action: "fanned", count: 2 });
    expect(f.executions.size).toBe(before + 2);
    expect(
      must(f.executions.get(executionName("acme/shop", 12, NEW, "d-status"))).input,
    ).toMatchObject({
      kind: "pr_checks",
      prNumber: 12,
      headSha: NEW,
      debounceSeconds: 20,
    });
    expect(f.executions.has(executionName("acme/shop", 13, NEW, "d-status"))).toBe(true);
  });
});
