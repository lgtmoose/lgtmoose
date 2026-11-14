import {
  type DescribeExecutionCommand,
  ListExecutionsCommand,
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
  type RunningExecution,
  type WorkflowInput,
} from "./dispatch.js";

const SM = "arn:aws:states:eu-west-1:123456789012:stateMachine:Review";
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    kind: "pr_updated",
    deliveryId: "d-1",
    installationId: 7,
    repo: "acme/shop",
    prNumber: 12,
    headSha: NEW,
    actor: "dev",
    receivedAt: "2026-11-14T00:00:00.000Z",
    ...overrides,
  };
}

/** A fake state machine: names are unique for good, as in Step Functions. */
function fakeDeps() {
  const executions = new Map<string, { input: WorkflowInput; status: string }>();
  const superseded: string[] = [];
  const stops: { arn: string; cause: string }[] = [];
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const deps: DispatchDeps = {
    executions: {
      async start(name, input) {
        const arn = executionArnOf(SM, name);
        const existing = executions.get(name);
        if (existing === undefined) {
          executions.set(name, { input, status: "RUNNING" });
          return { started: true, executionArn: arn };
        }
        const same = JSON.stringify(existing.input) === JSON.stringify(input);
        return { started: existing.status === "RUNNING" && same, executionArn: arn };
      },
      async status(name) {
        return executions.get(name)?.status;
      },
      async running(prefix) {
        const found: RunningExecution[] = [];
        for (const [name, execution] of executions) {
          if (execution.status === "RUNNING" && name.startsWith(prefix)) {
            found.push({ name, executionArn: executionArnOf(SM, name) });
          }
        }
        return found;
      },
      async stop(arn, cause) {
        stops.push({ arn, cause });
        const name = arn.slice(arn.lastIndexOf(":") + 1);
        const execution = executions.get(name);
        if (execution) execution.status = "ABORTED";
      },
    },
    runs: {
      async supersedeExecutions(arns) {
        superseded.push(...arns);
      },
    },
    log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
  };
  return { deps, executions, superseded, stops, logs };
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

  it("gives each PR a prefix no other PR's names start with", () => {
    const one = executionPrefix("acme/shop", 1);
    expect(executionName("acme/shop", 12, NEW).startsWith(one)).toBe(false);
  });
});

describe("dispatch", () => {
  it("starts a push's review with the debounce wait and its job as input", async () => {
    const f = fakeDeps();
    const result = await dispatch(f.deps, job());
    const name = executionName("acme/shop", 12, NEW);
    expect(result).toEqual({
      action: "started",
      executionArn: executionArnOf(SM, name),
      stopped: [],
    });
    expect(f.executions.get(name)?.input).toEqual({
      ...job(),
      debounceSeconds: PUSH_DEBOUNCE_SECONDS,
    });
  });

  it("starts an opened or ready PR's review at once", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened" }));
    await dispatch(f.deps, job({ kind: "pr_ready", headSha: OLD }));
    for (const sha of [NEW, OLD]) {
      expect(f.executions.get(executionName("acme/shop", 12, sha))?.input.debounceSeconds).toBe(0);
    }
  });

  it("stops the older head's execution and marks its run superseded", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ headSha: OLD }));
    await dispatch(f.deps, job({ kind: "pr_opened", repo: "acme/other", headSha: OLD }));
    const result = await dispatch(f.deps, job({ deliveryId: "d-2" }));
    const old = executionArnOf(SM, executionName("acme/shop", 12, OLD));
    expect(result).toMatchObject({ action: "started", stopped: [old] });
    expect(f.stops).toEqual([{ arn: old, cause: `Superseded by ${NEW}.` }]);
    expect(f.superseded).toEqual([old]);
    // Other PRs' executions keep running.
    expect(f.executions.get(executionName("acme/other", 12, OLD))?.status).toBe("RUNNING");
  });

  it("treats a second start for the same head as a duplicate and stops nothing", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ headSha: OLD }));
    await dispatch(f.deps, job({ deliveryId: "d-2" }));
    // A late redelivery of the old push must not stop the new head's review.
    const result = await dispatch(f.deps, job({ deliveryId: "d-1", headSha: OLD }));
    expect(result).toEqual({
      action: "duplicate",
      name: executionName("acme/shop", 12, OLD),
    });
    expect(f.executions.get(executionName("acme/shop", 12, NEW))?.status).toBe("RUNNING");
  });

  it("supersedes again when the same message is retried", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ headSha: OLD }));
    let fail = true;
    const { executions } = f.deps;
    const real = { ...executions };
    executions.stop = async (arn, cause) => {
      if (fail) throw new Error("throttled");
      await real.stop(arn, cause);
    };
    await expect(dispatch(f.deps, job({ deliveryId: "d-2" }))).rejects.toThrow("throttled");
    fail = false;
    const result = await dispatch(f.deps, job({ deliveryId: "d-2" }));
    expect(result).toMatchObject({ action: "started" });
    expect(f.superseded).toEqual([executionArnOf(SM, executionName("acme/shop", 12, OLD))]);
  });

  it("reviews a PR reopened at the head its close stopped, once per delivery", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened" }));
    await dispatch(f.deps, job({ kind: "pr_closed", deliveryId: "d-2" }));
    const reopened = job({ kind: "pr_opened", deliveryId: "d-3" });
    const result = await dispatch(f.deps, reopened);
    const retryName = executionName("acme/shop", 12, NEW, "d-3");
    expect(result).toEqual({ action: "retried", executionArn: executionArnOf(SM, retryName) });
    expect(retryName.length).toBeLessThanOrEqual(80);
    expect(retryName.startsWith(executionPrefix("acme/shop", 12))).toBe(true);
    expect(f.executions.get(retryName)?.status).toBe("RUNNING");

    // The same delivery again, once its retry has ended: a duplicate.
    const retried = f.executions.get(retryName);
    if (retried) retried.status = "FAILED";
    expect(await dispatch(f.deps, reopened)).toEqual({ action: "duplicate", name: retryName });
    // A later push supersedes the retry like any other execution.
    if (retried) retried.status = "RUNNING";
    const push = await dispatch(f.deps, job({ deliveryId: "d-4", headSha: OLD }));
    expect(push).toMatchObject({ stopped: [executionArnOf(SM, retryName)] });
  });

  it("doesn't retry a head that was reviewed, or a push", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job({ kind: "pr_opened" }));
    const first = f.executions.get(executionName("acme/shop", 12, NEW));
    if (first) first.status = "SUCCEEDED";
    expect(await dispatch(f.deps, job({ kind: "pr_ready", deliveryId: "d-2" }))).toMatchObject({
      action: "duplicate",
    });
    if (first) first.status = "ABORTED";
    expect(await dispatch(f.deps, job({ deliveryId: "d-3" }))).toMatchObject({
      action: "duplicate",
    });
    expect(f.executions.size).toBe(1);
  });

  it("stops every running execution of a closed PR", async () => {
    const f = fakeDeps();
    await dispatch(f.deps, job());
    const result = await dispatch(f.deps, job({ kind: "pr_closed", headSha: OLD }));
    const arn = executionArnOf(SM, executionName("acme/shop", 12, NEW));
    expect(result).toEqual({ action: "stopped", stopped: [arn] });
    expect(f.stops).toEqual([{ arn, cause: "Pull request closed." }]);
    expect(f.superseded).toEqual([arn]);
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
  const record = (messageId: string, body: unknown) => ({
    messageId,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  it("handles every message and reports no failures", async () => {
    const f = fakeDeps();
    const result = await dispatchBatch(f.deps, [
      record("m1", job({ headSha: OLD })),
      record("m2", job({ deliveryId: "d-2" })),
    ]);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(f.superseded).toHaveLength(1);
  });

  it("returns the first failure and every message after it, in order", async () => {
    const f = fakeDeps();
    const result = await dispatchBatch(f.deps, [
      record("m1", job()),
      record("m2", "not json"),
      record("m3", job({ repo: "acme/other" })),
    ]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m2" }, { itemIdentifier: "m3" }]);
    expect(f.executions.size).toBe(1);
    expect(f.logs.find((l) => l.message === "dispatch failed")?.fields).toMatchObject({
      messageId: "m2",
      error: "The message isn't JSON.",
    });
  });

  it("names a bad job's fields without quoting their values", async () => {
    const f = fakeDeps();
    await dispatchBatch(f.deps, [record("m1", { ...job(), repo: "secret value", prNumber: -1 })]);
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
    expect(await executions.start("n", input)).toEqual({ started: true, executionArn: "arn:new" });
    const sent = c.send.mock.calls[0]?.[0] as StartExecutionCommand;
    expect(sent.input).toEqual({ stateMachineArn: SM, name: "n", input: JSON.stringify(input) });
    expect(await executions.start("dup", input)).toEqual({
      started: false,
      executionArn: "arn:aws:states:eu-west-1:123456789012:execution:Review:dup",
    });
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

  it("lists running executions with the prefix across pages", async () => {
    const c = client((command) => {
      const token = (command as ListExecutionsCommand).input.nextToken;
      return token === undefined
        ? {
            executions: [
              { name: "p-1", executionArn: "arn:1" },
              { name: "q-1", executionArn: "arn:q" },
            ],
            nextToken: "t",
          }
        : { executions: [{ name: "p-2", executionArn: "arn:2" }] };
    });
    expect(await sfnExecutions(c, SM).running("p-")).toEqual([
      { name: "p-1", executionArn: "arn:1" },
      { name: "p-2", executionArn: "arn:2" },
    ]);
    const first = c.send.mock.calls[0]?.[0] as ListExecutionsCommand;
    expect(first).toBeInstanceOf(ListExecutionsCommand);
    expect(first.input).toMatchObject({ stateMachineArn: SM, statusFilter: "RUNNING" });
  });

  it("reads an execution's status by name, and undefined when there's none", async () => {
    const c = client((command) => {
      const arn = (command as DescribeExecutionCommand).input.executionArn;
      if (arn?.endsWith(":gone")) throw named("ExecutionDoesNotExist");
      return { status: "ABORTED" };
    });
    const executions = sfnExecutions(c, SM);
    expect(await executions.status("n")).toBe("ABORTED");
    expect(await executions.status("gone")).toBeUndefined();
    const sent = c.send.mock.calls[0]?.[0] as DescribeExecutionCommand | undefined;
    expect(sent?.input.executionArn).toBe(executionArnOf(SM, "n"));
  });

  it("stops with a cause, and ignores an execution that's gone", async () => {
    const c = client((command) => {
      if ((command as StopExecutionCommand).input.executionArn === "arn:gone") {
        throw named("ExecutionDoesNotExist");
      }
      return {};
    });
    const executions = sfnExecutions(c, SM);
    await executions.stop("arn:1", "why");
    await executions.stop("arn:gone", "why");
    const sent = c.send.mock.calls[0]?.[0] as StopExecutionCommand | undefined;
    expect(sent?.input).toEqual({
      executionArn: "arn:1",
      cause: "why",
    });
  });
});
