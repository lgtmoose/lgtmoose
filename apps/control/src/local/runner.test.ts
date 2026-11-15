import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { ReviewJob } from "@lgtmoose/core";
import { PostgresQueue, postgresArtifactStore, postgresExecutions, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { cloneAtSha } from "@lgtmoose/git";
import { runKeys, type BatchOutput, type PullRequest } from "@lgtmoose/pipeline";
import { ShadowPoster } from "@lgtmoose/poster";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleFindingStore, drizzleRunStore, tarArchive } from "../aws.js";
import { drizzleDispatchStore } from "../dispatch-aws.js";
import type { ControlDeps } from "../ports.js";
import { DEAD_QUEUE, JOBS_QUEUE, RUNNER_RESTARTED, createRunner } from "./runner.js";
import type { BatchRunner } from "./workflow.js";

const exec = promisify(execFile);

// The migrations create the vector extension (for learnings).
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);

// PGlite starts slowly, and more slowly while turbo runs other packages alongside.
beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lgtmoose-runner-"));
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
}, 30_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const store = postgresArtifactStore(db);

/** Each test gets its own PR number, so runs in the shared database don't meet. */
let nextPr = 100;

function setup(options: { runBatch?: BatchRunner } = {}) {
  const prNumber = nextPr++;
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const log = (message: string, fields?: Record<string, unknown>) => {
    logs.push({ message, ...(fields === undefined ? {} : { fields }) });
  };
  const pull = (): PullRequest => ({
    title: "Fix totals",
    body: "Small fix.",
    author: "dev",
    headSha,
    headRef: "feature",
    baseSha,
    baseRef: "main",
    state: "open",
  });
  const control: ControlDeps = {
    store,
    runs: drizzleRunStore(db),
    findings: drizzleFindingStore(db),
    // Prepare and post report back to Step Functions only on AWS.
    tokens: { succeed: async () => undefined, fail: async () => undefined },
    async github() {
      return {
        reader: { pull: async () => pull(), comments: async () => [] },
        threads: { reviewThreads: async () => [] },
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
    log,
  };
  /** The sandbox stand-in: one blocking finding on the changed loop, like a real reviewer's. */
  const reviewer: BatchRunner = async ({ runId, index }) => {
    const output: BatchOutput = {
      version: 1,
      index,
      findings: [
        {
          rule_category: "correctness",
          severity: "blocking",
          path: "src/total.ts",
          line: 3,
          side: "RIGHT",
          title: "Loop skips the last item",
          body: "The bound drops the last item from the total.",
          evidence: "for (let i = 0; i < items.length - 1; i++) {",
        },
      ],
      transcriptKeys: [],
    };
    await store.putText(runKeys(runId).batchOutput(index), JSON.stringify(output));
  };
  const jobs = new PostgresQueue(db, JOBS_QUEUE);
  const dead = new PostgresQueue(db, DEAD_QUEUE);
  const executions = postgresExecutions(db);
  const owner = `runner-${prNumber}`;
  const runner = createRunner({
    jobs,
    dead,
    executions,
    dispatchStore: drizzleDispatchStore(db),
    workflow: {
      control,
      runBatch: options.runBatch ?? reviewer,
      settings: { model: "", batchTimeoutMs: 60_000 },
      maxConcurrency: 2,
      attempts: 1,
      sleep: async () => undefined,
    },
    owner,
    maxExecutions: 2,
    log,
  });
  const job = (overrides: Partial<ReviewJob> = {}): ReviewJob => ({
    kind: "pr_opened",
    deliveryId: `delivery-${prNumber}-${Math.random()}`,
    installationId: 1,
    repo: "acme/shop",
    prNumber,
    headSha,
    actor: "dev",
    receivedAt: new Date().toISOString(),
    eventAt: new Date().toISOString(),
    ...overrides,
  });
  /** What the gateway does with a verified delivery (`postgresJobQueue`). */
  const deliver = (queued: ReviewJob) =>
    jobs.send({
      groupId: `${queued.repo}#${queued.prNumber}`,
      dedupeId: queued.deliveryId,
      body: JSON.stringify(queued),
    });
  /** Ticks until the runner has nothing left to do. */
  const drain = async () => {
    for (let round = 0; round < 10; round += 1) {
      const { jobs: taken, started } = await runner.tick();
      await runner.idle();
      if (taken === 0 && started === 0) return;
    }
    throw new Error("the runner didn't settle");
  };
  const runsOfPr = () =>
    db
      .select({ status: reviewRuns.status, executionArn: reviewRuns.executionArn })
      .from(reviewRuns)
      .where(eq(reviewRuns.executionArn, executions.arnOf(executionNameFor(prNumber))));
  return {
    prNumber,
    runner,
    jobs,
    dead,
    executions,
    owner,
    logs,
    job,
    deliver,
    drain,
    runsOfPr,
  };
}

/** Shadow records the post step wrote, of one kind (`review`, `check-run`…). */
async function shadowRecords(what: string): Promise<Record<string, unknown>[]> {
  const result = (await client.query<{ key: string; body: Buffer }>(
    `select key, body from artifacts where key like 'shadow/%' and key like '%-${what}.json'`,
  )) as { rows: { key: string; body: Buffer | Uint8Array }[] };
  return result.rows.map(
    (row) => JSON.parse(Buffer.from(row.body).toString("utf8")) as Record<string, unknown>,
  );
}

/** The execution name the dispatcher gives a PR's head (see `executionName`). */
let executionNameFor: (prNumber: number) => string = () => "";

beforeAll(async () => {
  const { executionName } = await import("../dispatch.js");
  executionNameFor = (prNumber) => executionName("acme/shop", prNumber, headSha);
});

describe("the compose runner", () => {
  it("takes a delivered job through dispatch, prepare, the batch and post", async () => {
    const t = setup();
    await t.deliver(t.job());
    await t.drain();

    const arn = t.executions.arnOf(executionNameFor(t.prNumber));
    expect(await t.executions.status(arn)).toBe("SUCCEEDED");
    expect(await t.runsOfPr()).toEqual([{ status: "succeeded", executionArn: arn }]);
    // The review the blocking finding asked for, recorded in shadow mode.
    const reviews = await shadowRecords("review");
    const ours = reviews.filter(
      (record) => (record.pull as { pull?: number } | undefined)?.pull === t.prNumber,
    );
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ event: "REQUEST_CHANGES" });
    // The job is done: nothing is waiting.
    expect(await t.jobs.receive(10, 60_000)).toEqual([]);
  }, 60_000);

  it("starts one review for a redelivered job", async () => {
    const t = setup();
    const job = t.job();
    await t.deliver(job);
    // GitHub redelivers: same delivery ID, dropped by the queue.
    expect(await t.deliver(job)).toBe(false);
    // A second delivery for the same head: the dispatcher's execution name dedupes it.
    await t.deliver(t.job({ kind: "pr_ready" }));
    await t.drain();
    expect(await t.runsOfPr()).toHaveLength(1);
  }, 60_000);

  it("posts an incomplete review, not an approval, when a batch fails", async () => {
    const t = setup({
      runBatch: async () => {
        throw new Error("the sandbox died");
      },
    });
    await t.deliver(t.job());
    await t.drain();
    const arn = t.executions.arnOf(executionNameFor(t.prNumber));
    expect(await t.executions.status(arn)).toBe("SUCCEEDED");
    const reviews = (await shadowRecords("review")).filter(
      (record) => (record.pull as { pull?: number } | undefined)?.pull === t.prNumber,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).not.toMatchObject({ event: "APPROVE" });
    expect(t.logs.map((entry) => entry.message)).toContain("batch failed");
  }, 60_000);

  it("dead-letters a message that isn't a job, and lets its PR's next job through", async () => {
    const t = setup();
    await t.jobs.send({ groupId: `acme/shop#${t.prNumber}`, dedupeId: "junk", body: "not json" });
    await t.runner.tick();
    const [letter] = await t.dead.receive(10, 60_000);
    expect(JSON.parse(letter?.body ?? "{}")).toMatchObject({ queue: JOBS_QUEUE, body: "not json" });
    expect(await t.jobs.receive(10, 60_000)).toEqual([]);
  });

  it("fails a run another runner process left running", async () => {
    const t = setup({
      runBatch: async () => {
        throw new Error("never reached");
      },
    });
    // Another runner took the execution, then its process stopped.
    const name = executionNameFor(t.prNumber);
    await t.executions.start(name, { ...t.job(), debounceSeconds: 0 });
    await t.executions.claim("a-runner-that-stopped", 100);
    expect(await t.runner.recover()).toBeGreaterThanOrEqual(1);
    expect(await t.executions.status(t.executions.arnOf(name))).toBe("FAILED");
    expect(t.logs.some((entry) => entry.fields?.error === RUNNER_RESTARTED)).toBe(true);
  }, 60_000);
});
