import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Finding } from "@lgtmoose/core";
import { cloneAtSha } from "@lgtmoose/git";
import { runKeys, type BatchOutput, type PullReader, type PullRequest } from "@lgtmoose/pipeline";
import { ShadowPoster } from "@lgtmoose/poster";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tarArchive } from "./aws.js";
import type { ArtifactStore, RunRecord, RunStore } from "./ports.js";
import { post } from "./post.js";
import { prepare, type RunManifest } from "./prepare.js";
import { POST_FAILED, PREPARE_FAILED, runCommand, type StepDeps } from "./run.js";

const exec = promisify(execFile);
const RUN_ID = "0b6f6d8e-3c1a-4c3e-9a51-6f1f0e0c2a11";
const EXECUTION = "arn:aws:states:eu-west-1:123456789012:execution:review:abc";
const SETTINGS = { model: "sonnet", batchTimeoutMs: 60_000 };

let root: string;
let work: string;
let remote: string;
let baseSha: string;
let headSha: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function commit(files: Record<string, string>, message: string): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), text);
  }
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "-m", message);
  await git(work, "push", "--quiet", "--force", "--all", "origin");
  return git(work, "rev-parse", "HEAD");
}

const TOTAL = [
  "export function total(items: Item[]): number {",
  "  let sum = 0;",
  "  for (let i = 0; i < items.length; i++) {",
  "    sum += items[i].price;",
  "  }",
  "  return sum;",
  "}",
  "",
].join("\n");
const LOOP = "for (let i = 0; i < items.length - 1; i++) {";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lgtmoose-control-"));
  work = join(root, "work");
  remote = join(root, "remote.git");
  await exec("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  for (const key of ["uploadpack.allowFilter", "uploadpack.allowAnySHA1InWant"]) {
    await git(remote, "config", key, "true");
  }
  await exec("git", ["init", "--quiet", "--initial-branch=main", work]);
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.com"],
    ["commit.gpgsign", "false"],
  ] as const) {
    await git(work, "config", key, value);
  }
  await git(work, "remote", "add", "origin", remote);
  baseSha = await commit({ "src/total.ts": TOTAL }, "base");
  await git(work, "checkout", "--quiet", "-b", "feature");
  headSha = await commit(
    { "src/total.ts": TOTAL.replace("i < items.length; i++", "i < items.length - 1; i++") },
    "head",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function finding(): Finding {
  return {
    rule_category: "correctness",
    severity: "blocking",
    path: "src/total.ts",
    line: 3,
    side: "RIGHT",
    title: "Loop skips the last item",
    body: "The bound drops the last item from the total.",
    evidence: LOOP,
  };
}

function pull(sha = headSha): PullRequest {
  return {
    title: "Fix totals",
    body: "Small fix.",
    author: "dev",
    headSha: sha,
    headRef: "feature",
    baseSha,
    baseRef: "main",
    state: "open",
  };
}

interface Run extends RunRecord {
  status: string;
  executionArn: string;
  filesTotal?: number;
  error?: string;
  result?: Parameters<RunStore["succeedRun"]>[1];
}

function memoryRuns(): RunStore & { runs: Map<string, Run> } {
  const runs = new Map<string, Run>();
  return {
    runs,
    async startRun(input) {
      const run: Run = {
        runId: RUN_ID,
        pullRequestId: "pr-1",
        summaryCommentId: 41,
        status: "running",
        executionArn: input.executionArn,
      };
      runs.set(RUN_ID, run);
      return run;
    },
    async getRun(runId) {
      return runs.get(runId);
    },
    async setFilesTotal(runId, filesTotal) {
      const run = runs.get(runId);
      if (run) run.filesTotal = filesTotal;
    },
    async succeedRun(runId, result) {
      const run = runs.get(runId);
      if (run?.status === "running") Object.assign(run, { status: "succeeded", result });
    },
    async failRun(executionArn, error) {
      for (const run of runs.values()) {
        if (run.executionArn === executionArn && run.status === "running") {
          Object.assign(run, { status: "failed", error });
        }
      }
    },
    async supersedeRun(runId) {
      const run = runs.get(runId);
      if (run) run.status = "superseded";
    },
  };
}

interface Setup {
  /** The head the PR is at when it's read. */
  head?: string;
  /** The PR's state when it's read. */
  state?: string;
}

function harness(setup: Setup = {}) {
  const objects = new Map<string, string>();
  const files = new Map<string, Buffer>();
  const logs: string[] = [];
  const tokens: { succeeded: unknown[]; failed: { error: string; cause: string }[] } = {
    succeeded: [],
    failed: [],
  };
  const installations: number[] = [];
  const store: ArtifactStore = {
    async putText(key, body) {
      objects.set(key, body);
    },
    async putFile(key, path) {
      files.set(key, await readFile(path));
    },
    async getText(key) {
      return objects.get(key);
    },
  };
  const runs = memoryRuns();
  const reader: PullReader = {
    pull: async () => ({ ...pull(setup.head ?? headSha), state: setup.state ?? "open" }),
    comments: async () => [],
  };
  const execution = { status: "RUNNING" as string | undefined };
  const heartbeats = { count: 0 };
  const deps: StepDeps = {
    executionStatus: async () => execution.status,
    heartbeat: async () => {
      heartbeats.count += 1;
    },
    store,
    runs,
    tokens: {
      async succeed(_token, output) {
        tokens.succeeded.push(output);
      },
      async fail(_token, error, cause) {
        tokens.failed.push({ error, cause });
      },
    },
    async github(installationId) {
      installations.push(installationId);
      return {
        reader,
        token: async () => "",
        poster: (runId) =>
          new ShadowPoster({ store: { put: (key, body) => store.putText(key, body) }, runId }),
      };
    },
    clone: cloneAtSha,
    cloneUrl: () => pathToFileURL(remote).href,
    async workDir() {
      const dir = await mkdtemp(join(root, "task-"));
      return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
    },
    archive: tarArchive,
    log: (message) => logs.push(message),
  };
  return { deps, objects, files, runs, tokens, installations, logs, execution, heartbeats };
}

const JOB = { installationId: 99, repo: "acme/shop", prNumber: 7 };

function output(overrides: Partial<BatchOutput> = {}): BatchOutput {
  return { version: 1, index: 0, findings: [finding()], transcriptKeys: [], ...overrides };
}

function shadowRecords(objects: Map<string, string>, what: string): Record<string, unknown>[] {
  return [...objects]
    .filter(([key]) => key.startsWith("shadow/") && key.endsWith(`-${what}.json`))
    .map(([, body]) => JSON.parse(body) as Record<string, unknown>);
}

describe("prepare", () => {
  it("records the run and writes the manifest, the checkout and each batch's input", async () => {
    const h = harness();
    const result = await prepare(h.deps, JOB, EXECUTION, SETTINGS);

    expect(result).toEqual({ runId: RUN_ID, superseded: false, batches: [{ index: 0 }] });
    const keys = runKeys(RUN_ID);
    const manifest = JSON.parse(h.objects.get(keys.prepared) ?? "") as RunManifest;
    expect(manifest.installationId).toBe(99);
    expect(manifest.review.pr.headSha).toBe(headSha);
    const input = JSON.parse(h.objects.get(keys.batchInput(0)) ?? "") as Record<string, unknown>;
    expect(input).toMatchObject({ version: 1, runId: RUN_ID, index: 0, model: "sonnet" });
    expect(input.prompt).toContain("src/total.ts");
    expect(h.runs.runs.get(RUN_ID)).toMatchObject({ filesTotal: 1, executionArn: EXECUTION });
    expect(h.files.has(keys.checkout)).toBe(true);
  });

  it("seals the checkout so git in the sandbox never fetches", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    const archive = join(root, "checkout.tar.gz");
    await writeFile(archive, h.files.get(runKeys(RUN_ID).checkout) ?? Buffer.alloc(0));
    const out = join(root, "sandbox");
    await mkdir(out);
    await exec("tar", ["-xzf", archive, "-C", out]);
    // The remote is gone, as it is for a sandbox; a lazy fetch would fail here.
    await rm(remote, { recursive: true, force: true });

    expect(await readFile(join(out, "src/total.ts"), "utf8")).toContain(LOOP);
    expect(await git(out, "diff", baseSha, headSha, "--", "src/total.ts")).toContain(LOOP);
    await expect(git(out, "config", "remote.origin.promisor")).rejects.toThrow();
  });

  it("marks the run superseded when the PR moved past the queued head", async () => {
    const h = harness();
    const result = await prepare(h.deps, { ...JOB, headSha: baseSha }, EXECUTION, SETTINGS);

    expect(result).toEqual({ runId: RUN_ID, superseded: true, batches: [] });
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("superseded");
    expect(h.objects.size).toBe(0);
  });
});

describe("post", () => {
  const shadowed = (h: ReturnType<typeof harness>) =>
    [...h.objects.keys()].filter((key) => key.startsWith("shadow/"));

  it.each([
    ["the PR's head moved on", { head: "f".repeat(40) }, true],
    ["the PR is closed", { state: "closed" }, true],
    ["its execution was stopped", {}, false],
  ])("posts nothing and records nothing when %s", async (reason, change, running) => {
    const setup: Setup = {};
    const h = harness(setup);
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    Object.assign(setup, change);
    const result = await post(h.deps, RUN_ID, async () => running);
    expect(result).toMatchObject({ posted: false });
    expect(shadowed(h)).toEqual([]);
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("running");
    expect(h.logs).toContain("not posted");
    expect(reason).toBeTruthy();
  });

  it("leaves the record to the newer run when it's stopped while posting", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    let checks = 0;
    const result = await post(h.deps, RUN_ID, async () => {
      checks += 1;
      return checks === 1;
    });
    expect(result).toMatchObject({ posted: false });
    expect(shadowed(h).length).toBeGreaterThan(0);
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("running");
  });

  it("posts the batches' findings as one review and records the run", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));

    const result = await post(h.deps, RUN_ID);

    expect(result).toEqual({
      runId: RUN_ID,
      posted: true,
      event: "REQUEST_CHANGES",
      complete: true,
      findings: 1,
    });
    expect(h.installations).toEqual([99, 99]);
    const [review] = shadowRecords(h.objects, "review");
    expect(review).toMatchObject({ commit_id: headSha });
    expect(JSON.stringify(review)).toContain("Loop skips the last item");
    const [comment] = shadowRecords(h.objects, "summary-comment");
    expect(comment).toMatchObject({ comment_id: 41 });
    expect(h.runs.runs.get(RUN_ID)).toMatchObject({
      status: "succeeded",
      result: { filesDone: 1, headSha },
    });
  });

  it("counts a missing batch output as a failed batch, so the review can't approve", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);

    const result = await post(h.deps, RUN_ID);

    expect(result.complete).toBe(false);
    expect(result.event).not.toBe("APPROVE");
  });

  it("rejects an output that doesn't match its schema or its batch", async () => {
    for (const body of [
      "not json",
      JSON.stringify({ ...output(), extra: true }),
      JSON.stringify(output({ index: 3 })),
    ]) {
      const h = harness();
      await prepare(h.deps, JOB, EXECUTION, SETTINGS);
      h.objects.set(runKeys(RUN_ID).batchOutput(0), body);

      const result = await post(h.deps, RUN_ID);

      expect(result).toMatchObject({ complete: false, findings: 0 });
    }
  });

  it("approves a clean, complete review", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output({ findings: [] })));

    expect(await post(h.deps, RUN_ID)).toMatchObject({ event: "APPROVE", complete: true });
  });
});

describe("runCommand", () => {
  it("sends prepare's output on its task token", async () => {
    const h = harness();
    await runCommand(
      h.deps,
      { command: "prepare", executionArn: EXECUTION, job: JSON.stringify(JOB), taskToken: "t" },
      { ...SETTINGS, shadow: true },
    );
    expect(h.tokens.succeeded).toEqual([
      { runId: RUN_ID, superseded: false, batches: [{ index: 0 }] },
    ]);
    expect(h.tokens.failed).toEqual([]);
  });

  const dead = () => Object.assign(new Error("Task Timed Out"), { name: "TaskTimedOut" });
  const prepareCommand = {
    command: "prepare" as const,
    executionArn: EXECUTION,
    job: JSON.stringify(JOB),
    taskToken: "t",
  };

  it("marks the run superseded when its execution was stopped during prepare", async () => {
    const h = harness();
    h.execution.status = "ABORTED";
    h.deps.tokens.succeed = async () => {
      throw dead();
    };
    await runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("superseded");

    // Any other error is the task's to fail with.
    h.deps.tokens.succeed = async () => {
      throw new Error("throttled");
    };
    await expect(runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true })).rejects.toThrow(
      "throttled",
    );
  });

  it("leaves the run to the retry when prepare's own attempt timed out", async () => {
    const h = harness();
    h.deps.tokens.succeed = async () => {
      throw dead();
    };
    await runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("running");
    // An execution that ended by its own steps keeps what they recorded.
    h.execution.status = "FAILED";
    await runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("running");
  });

  it("marks the run failed when prepare failed and its execution was stopped", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.execution.status = "ABORTED";
    h.deps.tokens.fail = async () => {
      throw dead();
    };
    await runCommand(h.deps, { ...prepareCommand, job: "{}" }, { ...SETTINGS, shadow: true });
    expect(h.runs.runs.get(RUN_ID)).toMatchObject({ status: "failed", error: PREPARE_FAILED });
  });

  it("sends heartbeats while a step runs, and stops when it's done", async () => {
    const h = harness();
    h.deps.heartbeatIntervalMs = 5;
    await runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    const beats = h.heartbeats.count;
    expect(beats).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.heartbeats.count).toBe(beats);
  });

  it("reports post on its task token, so stopping the execution can't cut it short", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output({ findings: [] })));
    const postCommand = { command: "post" as const, executionArn: EXECUTION, runId: RUN_ID };
    await runCommand(h.deps, { ...postCommand, taskToken: "p" }, { ...SETTINGS, shadow: true });
    expect(h.tokens.succeeded.at(-1)).toEqual({});
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("succeeded");

    // Stopped mid-post: the post still finishes and its run stays posted.
    h.execution.status = "ABORTED";
    h.deps.tokens.succeed = async () => {
      throw dead();
    };
    await runCommand(h.deps, { ...postCommand, taskToken: "p" }, { ...SETTINGS, shadow: true });
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("succeeded");

    // A failed post fails its token instead of throwing; stopped, it fails the run itself.
    h.execution.status = "RUNNING";
    await runCommand(
      h.deps,
      { ...postCommand, runId: "00000000-0000-4000-8000-000000000000", taskToken: "p" },
      { ...SETTINGS, shadow: true },
    );
    expect(h.tokens.failed.at(-1)).toMatchObject({ error: POST_FAILED });
    const other = harness();
    await prepare(other.deps, JOB, EXECUTION, SETTINGS);
    other.execution.status = "ABORTED";
    other.deps.tokens.fail = async () => {
      throw dead();
    };
    await runCommand(
      other.deps,
      { ...postCommand, runId: "00000000-0000-4000-8000-000000000000", taskToken: "p" },
      { ...SETTINGS, shadow: true },
    );
    expect(other.runs.runs.get(RUN_ID)).toMatchObject({ status: "failed", error: POST_FAILED });
  });

  it("fails prepare's task token instead of throwing", async () => {
    const h = harness();
    await runCommand(
      h.deps,
      { command: "prepare", executionArn: EXECUTION, job: "{}", taskToken: "t" },
      { ...SETTINGS, shadow: true },
    );
    expect(h.tokens.succeeded).toEqual([]);
    expect(h.tokens.failed).toEqual([{ error: PREPARE_FAILED, cause: expect.any(String) }]);
  });

  it("marks the execution's run failed and posts nothing", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    await runCommand(
      h.deps,
      { command: "fail", executionArn: EXECUTION, error: "States.TaskFailed" },
      { ...SETTINGS, shadow: true },
    );
    expect(h.runs.runs.get(RUN_ID)).toMatchObject({ status: "failed", error: "States.TaskFailed" });
    expect([...h.objects.keys()].filter((key) => key.startsWith("shadow/"))).toEqual([]);
  });
});
