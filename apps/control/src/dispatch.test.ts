import {
  type DescribeExecutionCommand,
  StartExecutionCommand,
  type StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import type { ReviewJob } from "@lgtmoose/core";
import { describe, expect, it, vi } from "vitest";
import { executionArnOf, sfnExecutions } from "./dispatch-aws.js";
import {
  PUSH_DEBOUNCE_SECONDS,
  dispatch,
  dispatchBatch,
  executionName,
  executionPrefix,
  type DispatchDeps,
  type DispatchedExecution,
  type WorkflowInput,
} from "./dispatch.js";

const SM = "arn:aws:states:eu-west-1:123456789012:stateMachine:Review";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const T1 = "2026-11-14T00:00:01.000Z";
const T2 = "2026-11-14T00:00:02.000Z";
const T3 = "2026-11-14T00:00:03.000Z";

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
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
  const calls: string[] = [];
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
      async status(name) {
        return executions.get(name)?.status;
      },
      async stop(executionArn) {
        calls.push(`stop ${executionArn}`);
        const execution = executions.get(executionArn.slice(executionArn.lastIndexOf(":") + 1));
        if (execution?.status === "RUNNING") execution.status = "ABORTED";
      },
    },
    store: {
      async latest(repo, n) {
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
    },
    log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
  };
  const status = (name: string) => executions.get(name)?.status;
  return { deps, executions, recorded, runs, reviewedHeads, calls, logs, status };
}

describe("executionName", () => {
  it("names the execution after the repository, the PR and the head", () => {
    const name = executionName("Acme/Shop", 12, NEW);
    expect(name).toMatch(/^acme_shop-[0-9a-f]{12}-12-b{40}$/);
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

  it("falls back to the gateway's time for a job without an event time", async () => {
    const f = fakeDeps();
    const untimed = job();
    delete untimed.eventAt;
    await dispatch(f.deps, untimed);
    expect(f.recorded.get(arn(nameOf(NEW)))?.eventAt).toEqual(new Date(untimed.receivedAt));
  });

  it("defers comment jobs to M5 and ignores a push without a head", async () => {
    const f = fakeDeps();
    expect(await dispatch(f.deps, job({ kind: "comment", commentId: 3 }))).toMatchObject({
      action: "deferred",
    });
    const headless = job();
    delete headless.headSha;
    expect(await dispatch(f.deps, headless)).toEqual({ action: "ignored", reason: "no head SHA" });
    expect(f.executions.size).toBe(0);
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
    const result = await dispatchBatch(f.deps, [
      record("m1", "a", job()),
      record("m2", "b", "not json"),
      record("m3", "a", job({ repo: "acme/shop", eventAt: T3, headSha: OLD })),
      record("m4", "b", job({ repo: "acme/other" })),
      record("m5", "c", job({ repo: "acme/third" })),
    ]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m2" }, { itemIdentifier: "m4" }]);
    expect(f.executions.has(executionName("acme/third", 12, NEW))).toBe(true);
    expect(f.executions.has(executionName("acme/other", 12, NEW))).toBe(false);
    expect(f.logs.find((l) => l.message === "dispatch failed")?.fields).toMatchObject({
      messageId: "m2",
      error: "The message isn't JSON.",
    });
  });

  it("holds back everything after a failed message without a group", async () => {
    const f = fakeDeps();
    const result = await dispatchBatch(f.deps, [
      record("m1", undefined, "{}"),
      record("m2", "a", job()),
    ]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }, { itemIdentifier: "m2" }]);
  });

  it("names a bad job's fields without quoting their values", async () => {
    const f = fakeDeps();
    await dispatchBatch(f.deps, [
      record("m1", "a", { ...job(), repo: "secret value", prNumber: -1 }),
    ]);
    const error = String(f.logs.find((l) => l.message === "dispatch failed")?.fields?.error);
    expect(error).toContain("repo");
    expect(error).toContain("prNumber");
    expect(error).not.toContain("secret value");
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

  it("reads an execution's status by name, and undefined when there's none", async () => {
    const c = client((command) => {
      const executionArn = (command as DescribeExecutionCommand).input.executionArn;
      if (executionArn?.endsWith(":gone")) throw named("ExecutionDoesNotExist");
      return { status: "ABORTED" };
    });
    const executions = sfnExecutions(c, SM);
    expect(await executions.status("n")).toBe("ABORTED");
    expect(await executions.status("gone")).toBeUndefined();
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
