import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Finding } from "@lgtmoose/core";
import { cloneAtSha } from "@lgtmoose/git";
import { runKeys, type BatchOutput, type PullReader, type PullRequest } from "@lgtmoose/pipeline";
import { GitHubError, ShadowPoster, type Poster } from "@lgtmoose/poster";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tarArchive } from "./aws.js";
import type { ArtifactStore, RunRecord, RunStore } from "./ports.js";
import { SUMMARY_MARKER, post, reviewMarker, type PostAttempt } from "./post.js";
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

function memoryRuns(): RunStore & { runs: Map<string, Run>; newer: { posted: boolean } } {
  const runs = new Map<string, Run>();
  /** Whether a newer run of the PR has posted, as the test sets it. */
  const newer = { posted: false };
  return {
    runs,
    newer,
    async newerRunPosted() {
      return newer.posted;
    },
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
      if (run) Object.assign(run, { status: "succeeded", result });
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
      if (run?.status === "running") run.status = "superseded";
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
  // ETags for the conditional writes: a new one on every write of a key.
  const etags = new Map<string, string>();
  let version = 0;
  const tagged = (key: string, body: string) => {
    version += 1;
    objects.set(key, body);
    etags.set(key, `"v${version}"`);
    return `"v${version}"`;
  };
  const store: ArtifactStore = {
    async putText(key, body) {
      objects.set(key, body);
    },
    async putFile(key, path) {
      files.set(key, await readFile(path));
    },
    // Like `conditionalPut` in aws.ts: a failed condition on an object holding exactly this
    // body counts as our own earlier write.
    async createText(key, body) {
      if (objects.has(key)) return objects.get(key) === body ? etags.get(key) : undefined;
      return tagged(key, body);
    },
    async replaceText(key, body, etag) {
      if (etags.get(key) === etag && objects.has(key)) return tagged(key, body);
      return objects.get(key) === body ? etags.get(key) : undefined;
    },
    async getTagged(key) {
      const text = objects.get(key);
      if (text === undefined) return undefined;
      // An object a test put there directly gets its ETag on first read.
      if (!etags.has(key)) etags.set(key, `"set-${key}"`);
      return { text, etag: etags.get(key) ?? "" };
    },
    async deleteIfMatch(key, etag) {
      if (etags.get(key) === etag) {
        objects.delete(key);
        etags.delete(key);
      }
    },
    async getText(key) {
      return objects.get(key);
    },
  };
  const runs = memoryRuns();
  /** Markers of the reviews "on GitHub", as the test sets them. */
  const reviewsOnGitHub = new Set<string>();
  /** ECS task statuses by ARN, as the test sets them. */
  const tasks = new Map<string, string>();
  const reader: PullReader = {
    pull: async () => ({ ...pull(setup.head ?? headSha), state: setup.state ?? "open" }),
    comments: async () => [],
  };
  const execution = { status: "RUNNING" as string | undefined };
  const heartbeats = { count: 0 };
  const deps: StepDeps = {
    executionStatus: async () => execution.status,
    taskArn: async () => undefined,
    taskStatus: async (arn) => tasks.get(arn) ?? "MISSING",
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
        poster: (runId) => {
          const shadow = new ShadowPoster({
            store: { put: (key, body) => store.putText(key, body) },
            runId,
          });
          // As if the reviews were on GitHub, for the tests that put them there.
          shadow.reviewPosted = async (_pull, marker) => reviewsOnGitHub.has(marker);
          return shadow;
        },
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
  return {
    deps,
    objects,
    files,
    runs,
    tokens,
    installations,
    logs,
    execution,
    heartbeats,
    reviewsOnGitHub,
    tasks,
  };
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
    const result = await post(h.deps, RUN_ID, { running: async () => running });
    expect(result).toMatchObject({ posted: false });
    expect(shadowed(h)).toEqual([]);
    // Superseded, with nothing recorded for the PR.
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("superseded");
    expect(h.runs.runs.get(RUN_ID)).not.toHaveProperty("result");
    expect(h.logs).toContain("not posted");
    expect(reason).toBeTruthy();
  });

  /** Counts the poster's calls, and fails the first `fail` calls of the named one. */
  function countingPoster(
    h: ReturnType<typeof harness>,
    fail?: { what: keyof Poster; times: number },
  ) {
    const calls: string[] = [];
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (installationId) => {
      const real = await github(installationId);
      return {
        ...real,
        poster: (runId, pull) => {
          const poster = real.poster(runId, pull);
          const wrap =
            <K extends keyof Poster>(what: K) =>
            async (...args: Parameters<Poster[K]>) => {
              calls.push(what);
              if (fail?.what === what && fail.times > 0) {
                fail.times -= 1;
                throw new Error("GitHub 502");
              }
              return (poster[what] as (...a: Parameters<Poster[K]>) => unknown)(...args);
            };
          return {
            ...poster,
            submitReview: wrap("submitReview"),
            completeCheckRun: wrap("completeCheckRun"),
            upsertSummaryComment: wrap("upsertSummaryComment"),
            startCheckRun: wrap("startCheckRun"),
            labels: (ref) => {
              calls.push("labels");
              return poster.labels(ref);
            },
          } as Poster;
        },
      };
    };
    return calls;
  }

  it("records the review when a later write fails, and a retry finishes the rest", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h, { what: "upsertSummaryComment", times: 1 });
    // Off ECS, as on a laptop: the retry, a new attempt, takes the first one's claim over.
    const offEcs = (id: string) => ({ attempt: { id, taskArn: undefined } });
    await expect(post(h.deps, RUN_ID, offEcs("a1"))).rejects.toThrow("GitHub 502");
    // The review is on GitHub, so the run is recorded, with the summary comment it already had.
    expect(h.runs.runs.get(RUN_ID)).toMatchObject({
      status: "succeeded",
      result: { headSha, summaryCommentId: 41 },
    });
    // The retry doesn't post the review or the check run again.
    calls.length = 0;
    expect(await post(h.deps, RUN_ID, offEcs("a2"))).toMatchObject({ posted: true });
    expect(calls).toEqual(["upsertSummaryComment", "labels"]);
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("succeeded");
  });

  it("carries on a retry whose review is posted even if the head moved meanwhile", async () => {
    const setup: Setup = {};
    const h = harness(setup);
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    countingPoster(h, { what: "completeCheckRun", times: 1 });
    await expect(
      post(h.deps, RUN_ID, { attempt: { id: "a1", taskArn: undefined } }),
    ).rejects.toThrow("GitHub 502");
    setup.head = "f".repeat(40);
    expect(
      await post(h.deps, RUN_ID, {
        attempt: { id: "a2", taskArn: undefined },
        running: async () => false,
      }),
    ).toMatchObject({ posted: true });
  });

  const TASK_A = "arn:aws:ecs:eu-west-1:123456789012:task/lgtmoose/aaa";
  const TASK_B = "arn:aws:ecs:eu-west-1:123456789012:task/lgtmoose/bbb";
  const as = (taskArn: string, id = taskArn): { attempt: PostAttempt } => ({
    attempt: { id, taskArn },
  });
  async function ready() {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h);
    const taskStatus = (arn: string) => h.deps.taskStatus(arn);
    return { h, calls, claim: runKeys(RUN_ID).reviewClaim, taskStatus };
  }
  const reviews = (calls: string[]) => calls.filter((call) => call === "submitReview");

  it("posts the review once when a retry overlaps the attempt it replaced", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    h.tasks.set(TASK_A, "RUNNING");
    h.tasks.set(TASK_B, "RUNNING");
    // Both attempts read no saved progress, as when they overlap: the first claims the review,
    // the second finds the claim held by a running task and backs off.
    const getTagged = h.deps.store.getTagged.bind(h.deps.store);
    h.deps.store.getTagged = async (key) =>
      key === runKeys(RUN_ID).posted ? undefined : getTagged(key);
    const [first, second] = await Promise.allSettled([
      post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus }),
      post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus }),
    ]);
    expect(reviews(calls)).toHaveLength(1);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const holder = (JSON.parse(h.objects.get(claim) ?? "{}") as { taskArn?: string }).taskArn;
    expect([TASK_A, TASK_B]).toContain(holder);
  });

  it("finds a review on GitHub that a stopped claimer posted", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    h.objects.set(claim, JSON.stringify({ attempt: "old", taskArn: TASK_A }));
    h.reviewsOnGitHub.add(reviewMarker(RUN_ID));
    expect(await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toEqual([]);
  });

  it("waits for a running claimer, and takes the claim over once its task has stopped", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "old", taskArn: TASK_A }));
    h.tasks.set(TASK_A, "RUNNING");
    await expect(post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).rejects.toThrow(
      "task RUNNING",
    );
    expect(reviews(calls)).toEqual([]);
    h.tasks.set(TASK_A, "STOPPED");
    expect(await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toHaveLength(1);
    expect(JSON.parse(h.objects.get(claim) ?? "{}")).toMatchObject({ taskArn: TASK_B });
  });

  it("leaves an off-ECS holder's claim alone when on ECS", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "laptop" }));
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow("off ECS");
    expect(calls).toEqual([]);
  });

  it("checks GitHub for the review only when it took a claim over", async () => {
    const { h, claim, taskStatus } = await ready();
    let lookups = 0;
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (id) => {
      const real = await github(id);
      return {
        ...real,
        poster: (runId, pull) => {
          const poster = real.poster(runId, pull);
          const reviewPosted = poster.reviewPosted.bind(poster);
          poster.reviewPosted = async (ref, marker) => {
            lookups += 1;
            return reviewPosted(ref, marker);
          };
          return poster;
        },
      };
    };
    await post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus });
    expect(lookups).toBe(0);
    // A later attempt that takes over a stopped holder's claim, with no saved review, looks.
    h.objects.delete(runKeys(RUN_ID).posted);
    h.tasks.set(TASK_A, "STOPPED");
    h.reviewsOnGitHub.add(reviewMarker(RUN_ID));
    await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus });
    expect(lookups).toBe(1);
    expect(JSON.parse(h.objects.get(claim) ?? "{}")).toMatchObject({ taskArn: TASK_B });
  });

  it("records nothing when it doesn't hold the claim", async () => {
    const { h, claim, taskStatus } = await ready();
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "old", taskArn: TASK_A }));
    h.tasks.set(TASK_A, "RUNNING");
    // The holder has posted the review and is still at the rest.
    const progress = JSON.stringify({ attempt: "old", writes: 1, review: true });
    await h.deps.store.createText(runKeys(RUN_ID).posted, progress);
    await expect(post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).rejects.toThrow();
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("running");
    expect(h.objects.get(runKeys(RUN_ID).posted)).toBe(progress);
  });

  it("lets only one attempt take over a stopped claimer's claim", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "old", taskArn: TASK_A }));
    h.tasks.set(TASK_A, "STOPPED");
    // Another attempt takes it over between this one's read and its write.
    const { store } = h.deps;
    const getTagged = store.getTagged.bind(store);
    store.getTagged = async (key) => {
      const read = await getTagged(key);
      if (read !== undefined) {
        await store.replaceText(key, JSON.stringify({ attempt: "x", taskArn: TASK_B }), read.etag);
      }
      return read;
    };
    await expect(post(h.deps, RUN_ID, { ...as(TASK_B, "mine"), taskStatus })).rejects.toThrow(
      "took over",
    );
    expect(reviews(calls)).toEqual([]);
  });

  it("releases its claim when GitHub refuses the review, and keeps it when unsure", async () => {
    const { h, claim, taskStatus } = await ready();
    const github = h.deps.github.bind(h.deps);
    let failure: Error = new GitHubError(422, "Unprocessable", "POST", "/reviews");
    h.deps.github = async (id) => {
      const real = await github(id);
      return {
        ...real,
        poster: (runId, pull) => ({
          ...real.poster(runId, pull),
          submitReview: async () => {
            throw failure;
          },
        }),
      };
    };
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow();
    expect(h.objects.has(claim)).toBe(false);
    // A timeout: the review may be on GitHub, so the claim stays for a later attempt to check.
    failure = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow();
    expect(h.objects.has(claim)).toBe(true);
  });

  it("keeps GitHub's refusal as the error when releasing the claim fails too", async () => {
    const { h, taskStatus } = await ready();
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (id) => {
      const real = await github(id);
      return {
        ...real,
        poster: (runId, pull) => ({
          ...real.poster(runId, pull),
          submitReview: async () => {
            throw new GitHubError(422, "Unprocessable", "POST", "/reviews");
          },
        }),
      };
    };
    h.deps.store.deleteIfMatch = async () => {
      throw new Error("S3 down");
    };
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow("HTTP 422");
    expect(h.logs).toContain("releasing the review claim failed");
  });

  it("takes over a claim whose holder's task ECS has deleted", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "old", taskArn: TASK_A }));
    h.tasks.set(TASK_A, "DELETED");
    expect(await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toHaveLength(1);
  });

  it("marks its review so a retry can find it", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    await post(h.deps, RUN_ID);
    const [review] = shadowRecords(h.objects, "review");
    expect(JSON.stringify(review)).toContain(`<!-- ${reviewMarker(RUN_ID)} -->`);
  });

  it("fails its step rather than overwrite progress another attempt saved", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h);
    // Another attempt saves progress after this one read it.
    const { store } = h.deps;
    const getTagged = store.getTagged.bind(store);
    store.getTagged = async (key) => {
      const read = await getTagged(key);
      if (key === runKeys(RUN_ID).posted) await store.createText(key, JSON.stringify({}));
      return read;
    };
    await expect(post(h.deps, RUN_ID)).rejects.toThrow("saved this post's progress");
    // The review went up before the save failed; the run is recorded and nothing else posted.
    expect(calls).toEqual(["submitReview"]);
  });

  it("saves progress that names its attempt and counts its writes", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    await post(h.deps, RUN_ID, as(TASK_A, "attempt-1"));
    expect(JSON.parse(h.objects.get(runKeys(RUN_ID).posted) ?? "{}")).toMatchObject({
      attempt: "attempt-1",
      writes: 4,
      review: true,
      checkRun: true,
      summary: true,
    });
  });

  it("waits for a live earlier attempt before writing anything, the review posted or not", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "old", taskArn: TASK_A }));
    h.tasks.set(TASK_A, "RUNNING");
    // It posted the review and saved that, and is still sending annotations.
    await h.deps.store.createText(runKeys(RUN_ID).posted, JSON.stringify({ review: true }));
    await expect(post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).rejects.toThrow(
      "task RUNNING",
    );
    expect(calls).toEqual([]);
    h.tasks.set(TASK_A, "STOPPED");
    expect(await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(calls).not.toContain("submitReview");
  });

  it("creates its check run and summary comment idempotently", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const seen: { externalId?: string; marker?: string } = {};
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (id) => {
      const real = await github(id);
      return {
        ...real,
        poster: (runId, pull) => {
          const poster = real.poster(runId, pull);
          return {
            ...poster,
            submitReview: poster.submitReview.bind(poster),
            labels: poster.labels.bind(poster),
            startCheckRun: poster.startCheckRun.bind(poster),
            completeCheckRun: async (ref, input) => {
              if (input.externalId !== undefined) seen.externalId = input.externalId;
              return poster.completeCheckRun(ref, input);
            },
            upsertSummaryComment: async (ref, body, commentId, marker) => {
              if (marker !== undefined) seen.marker = marker;
              return poster.upsertSummaryComment(ref, body, commentId, marker);
            },
          };
        },
      };
    };
    await post(h.deps, RUN_ID);
    // GitHubPoster reuses the check run with this external ID, and the comment with this marker.
    expect(seen).toEqual({ externalId: RUN_ID, marker: SUMMARY_MARKER });
  });

  it("fails rather than start over when its saved progress can't be read", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h);
    for (const bad of ["{", JSON.stringify({ review: "yes" })]) {
      h.objects.set(runKeys(RUN_ID).posted, bad);
      await expect(post(h.deps, RUN_ID)).rejects.toThrow("saved progress");
    }
    expect(calls).toEqual([]);
  });

  it("leaves the summary and label to a newer run that already posted", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h);
    h.runs.newer.posted = true;
    expect(await post(h.deps, RUN_ID)).toMatchObject({ posted: true });
    expect(calls).toEqual(["submitReview", "completeCheckRun"]);
  });

  it("leaves the label to a newer run that posts while the summary is written", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h);
    let checks = 0;
    h.runs.newerRunPosted = async () => {
      checks += 1;
      // The newer run finishes posting after this run's summary check.
      return checks > 1;
    };
    expect(await post(h.deps, RUN_ID)).toMatchObject({ posted: true });
    expect(calls).toEqual(["submitReview", "completeCheckRun", "upsertSummaryComment"]);
    expect(checks).toBe(2);
  });

  it("records what it posted when it's stopped while posting", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    let checks = 0;
    const result = await post(h.deps, RUN_ID, {
      running: async () => {
        checks += 1;
        return checks === 1;
      },
    });
    // Checked once, before the first write; after that it records what it posted.
    expect(checks).toBe(1);
    expect(result).toMatchObject({ posted: true });
    expect(shadowed(h).length).toBeGreaterThan(0);
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("succeeded");
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

  it("beats at once, keeps beating after a failed beat, and stops on a dead token", async () => {
    const h = harness();
    h.deps.heartbeatIntervalMs = 5;
    // Stopped: the step finishes its work, and reports nothing on the dead token.
    h.execution.status = "ABORTED";
    const errors = [new Error("throttled"), dead()];
    let beats = 0;
    h.deps.heartbeat = async () => {
      beats += 1;
      const error = errors.shift();
      if (error) throw error;
    };
    const running = runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    const atStart = beats;
    await running;
    // One beat before any work, a throttled beat that didn't stop them, then the dead token.
    expect(atStart).toBe(1);
    expect(beats).toBe(2);
    expect(h.logs.filter((line) => line === "heartbeat failed")).toHaveLength(2);
    expect(h.tokens.succeeded).toHaveLength(1);
  });

  it("gives the step up when its token dies on a running execution: a retry has it", async () => {
    const h = harness();
    h.deps.heartbeatIntervalMs = 5;
    let beats = 0;
    let died: () => void = () => undefined;
    const tokenDied = new Promise<void>((resolve) => {
      died = resolve;
    });
    h.deps.heartbeat = async () => {
      beats += 1;
      if (beats === 1) return;
      died();
      throw dead();
    };
    // The clone waits until the token has died, so the step is mid-work when it does.
    let cloned = false;
    const clone = h.deps.clone.bind(h.deps);
    h.deps.clone = async (options) => {
      await tokenDied;
      await new Promise((resolve) => setTimeout(resolve, 50));
      cloned = true;
      return clone(options);
    };
    await runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    expect(cloned).toBe(false);
    expect(h.logs).toContain("gave up the step: a retry has taken over");
    // Nothing reported on the token, and the retry's outcome isn't touched.
    expect(h.tokens.succeeded).toEqual([]);
    expect(h.tokens.failed).toEqual([]);
  });

  /** The token dies on the second heartbeat, while the clone waits for it. */
  function dyingMidClone(h: ReturnType<typeof harness>) {
    h.deps.heartbeatIntervalMs = 5;
    h.deps.statusRetryMs = 1;
    let beats = 0;
    let died: () => void = () => undefined;
    const tokenDied = new Promise<void>((resolve) => {
      died = resolve;
    });
    h.deps.heartbeat = async () => {
      beats += 1;
      if (beats === 1) return;
      died();
      throw dead();
    };
    const clone = h.deps.clone.bind(h.deps);
    const state = { cloned: false };
    h.deps.clone = async (options) => {
      await tokenDied;
      await new Promise((resolve) => setTimeout(resolve, 50));
      state.cloned = true;
      return clone(options);
    };
    return state;
  }

  it("carries on with the step when its execution's status can't be had", async () => {
    const h = harness();
    const state = dyingMidClone(h);
    let checks = 0;
    h.deps.executionStatus = async () => {
      checks += 1;
      throw new Error("throttled");
    };
    // The work finishes: the claim, not giving up, guards against a retry that overlaps it.
    await expect(
      runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true }),
    ).resolves.toBeUndefined();
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(state.cloned).toBe(true);
    expect(h.logs).not.toContain("gave up the step: a retry has taken over");
  });

  it("checks the status again when reporting on a dead token", async () => {
    const h = harness();
    h.deps.statusRetryMs = 1;
    h.deps.tokens.succeed = async () => {
      throw dead();
    };
    let checks = 0;
    h.deps.executionStatus = async () => {
      checks += 1;
      if (checks < 2) throw new Error("throttled");
      return "ABORTED";
    };
    await runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("superseded");
  });

  it("finishes the step when a retried check confirms its execution was stopped", async () => {
    const h = harness();
    dyingMidClone(h);
    let checks = 0;
    h.deps.executionStatus = async () => {
      checks += 1;
      if (checks < 3) throw new Error("throttled");
      return "ABORTED";
    };
    await runCommand(h.deps, prepareCommand, { ...SETTINGS, shadow: true });
    expect(h.logs).not.toContain("gave up the step: a retry has taken over");
    expect(h.tokens.succeeded).toHaveLength(1);
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

  it("fails the post step's token when it can't read its own task ARN", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.deps.taskArn = async () => {
      throw new Error("The task metadata endpoint answered 500.");
    };
    await runCommand(
      h.deps,
      { command: "post", executionArn: EXECUTION, runId: RUN_ID, taskToken: "p" },
      { ...SETTINGS, shadow: true },
    );
    expect(h.tokens.failed).toEqual([
      { error: POST_FAILED, cause: expect.stringContaining("500") },
    ]);
  });

  it("reports post on its task token, so stopping the execution can't cut it short", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output({ findings: [] })));
    const postCommand = { command: "post" as const, executionArn: EXECUTION, runId: RUN_ID };
    await runCommand(h.deps, { ...postCommand, taskToken: "p" }, { ...SETTINGS, shadow: true });
    expect(h.tokens.succeeded.at(-1)).toEqual({});
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("succeeded");

    // A failing post on a stopped execution leaves a finished run as it is.
    h.deps.tokens.succeed = async () => {
      throw dead();
    };
    h.execution.status = "ABORTED";
    await runCommand(
      h.deps,
      { ...postCommand, runId: "00000000-0000-4000-8000-000000000001", taskToken: "p" },
      { ...SETTINGS, shadow: true },
    ).catch(() => undefined);
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
