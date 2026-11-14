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
import type {
  ArtifactStore,
  ControlDeps,
  FileRecord,
  FindingRecord,
  FindingStore,
  RunRecord,
  RunStore,
} from "./ports.js";
import { post } from "./post.js";
import { RESUME_RUNS, prepare, type RunManifest } from "./prepare.js";
import { PREPARE_FAILED, runCommand } from "./run.js";

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
const HEAD_TOTAL = TOTAL.replace("i < items.length; i++", "i < items.length - 1; i++");

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
  kind?: string;
  fromSha?: string;
  error?: string;
  result?: Parameters<RunStore["succeedRun"]>[1];
  files: FileRecord[];
}

/** Run IDs in the order runs start: RUN_ID first. */
const runId = (n: number) =>
  n === 0 ? RUN_ID : `0b6f6d8e-3c1a-4c3e-9a51-${String(n).padStart(12, "0")}`;

/** One PR's runs, like `drizzleRunStore` keeps them. */
function memoryRuns(): RunStore & { runs: Map<string, Run>; pr: Partial<RunRecord> } {
  const runs = new Map<string, Run>();
  const pr: Partial<RunRecord> = { summaryCommentId: 41 };
  const current = (run: Run): Run =>
    Object.assign(run, {
      summaryCommentId: pr.summaryCommentId,
      lastReviewedSha: pr.lastReviewedSha,
      statusLabel: pr.statusLabel,
    });
  return {
    runs,
    pr,
    async startRun(input) {
      for (const run of runs.values())
        if (run.executionArn === input.executionArn) return current(run);
      const run: Run = current({
        runId: runId(runs.size),
        pullRequestId: "pr-1",
        summaryCommentId: undefined,
        lastReviewedSha: undefined,
        statusLabel: undefined,
        status: "running",
        executionArn: input.executionArn,
        files: [],
      });
      runs.set(run.runId, run);
      return run;
    },
    async getRun(id) {
      const run = runs.get(id);
      return run === undefined ? undefined : current(run);
    },
    async setPlan(id, plan) {
      const run = runs.get(id);
      if (run)
        Object.assign(run, { filesTotal: plan.filesTotal, kind: plan.kind, fromSha: plan.fromSha });
    },
    async reviewedFiles() {
      return [...runs.values()].flatMap((run) =>
        run.status === "succeeded" ? run.files.map(({ path, blobSha }) => ({ path, blobSha })) : [],
      );
    },
    async recordFiles(id, files) {
      const run = runs.get(id);
      if (!run) return;
      for (const file of files) {
        if (!run.files.some((known) => known.path === file.path)) run.files.push(file);
      }
    },
    async unpostedRuns(_pr, exceptRunId, limit) {
      const all = [...runs.values()];
      const last = all.findLastIndex((run) => run.status === "succeeded");
      return all
        .slice(last + 1)
        .filter((run) => run.runId !== exceptRunId)
        .reverse()
        .slice(0, limit)
        .map((run) => run.runId);
    },
    async succeedRun(id, result) {
      const run = runs.get(id);
      if (!run) return;
      Object.assign(run, { status: "succeeded", result });
      Object.assign(pr, {
        lastReviewedSha: result.headSha,
        statusLabel: result.statusLabel,
        summaryCommentId: result.summaryCommentId,
      });
    },
    async failRun(executionArn, error) {
      for (const run of runs.values()) {
        if (run.executionArn === executionArn && run.status === "running") {
          Object.assign(run, { status: "failed", error });
        }
      }
    },
    async supersedeRun(id) {
      const run = runs.get(id);
      if (run) run.status = "superseded";
    },
  };
}

interface StoredFinding extends FindingRecord {
  status: "open" | "outdated";
}

/** `findings` for one PR, like `drizzleFindingStore`. */
function memoryFindings(): FindingStore & { rows: StoredFinding[] } {
  const rows: StoredFinding[] = [];
  return {
    rows,
    async openFindings() {
      return rows.filter((row) => row.status === "open").map(({ status: _, ...row }) => row);
    },
    async saveFindings(_pr, _run, headSha, posted) {
      for (const { finding, fingerprint } of posted) {
        const row: StoredFinding = {
          id: `f${rows.length}`,
          fingerprint,
          ruleCategory: finding.rule_category,
          severity: finding.severity,
          path: finding.path,
          line: finding.line,
          startLine: finding.start_line,
          side: finding.side,
          title: finding.title,
          body: finding.body,
          raisedAtSha: headSha,
          status: "open",
        };
        const at = rows.findIndex((known) => known.fingerprint === fingerprint);
        if (at === -1) rows.push(row);
        else rows[at] = { ...row, id: rows[at]?.id ?? row.id };
      }
    },
    async markOutdated(ids) {
      for (const row of rows) if (ids.includes(row.id)) row.status = "outdated";
    },
  };
}

interface Setup {
  /** The head the PR is at when it's read. */
  head?: string;
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
  const findings = memoryFindings();
  const reader: PullReader = {
    pull: async () => pull(setup.head ?? headSha),
    comments: async () => [],
  };
  const deps: ControlDeps = {
    store,
    runs,
    findings,
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
  return { deps, objects, files, runs, findings, tokens, installations, logs, setup };
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
  it("posts the batches' findings as one review and records the run", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));

    const result = await post(h.deps, RUN_ID);

    expect(result).toEqual({
      runId: RUN_ID,
      event: "REQUEST_CHANGES",
      complete: true,
      findings: 1,
      reviewed: true,
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

describe("later runs", () => {
  const OTHER = "export const rate = 2;\n";
  const exec = (n: number) => `${EXECUTION}-${n}`;

  /** The PR also changes src/other.ts; returns the new head. */
  async function addOther(text = "export const rate = 3;\n"): Promise<string> {
    headSha = await commit({ "src/other.ts": text }, "other");
    return headSha;
  }

  /** Prepares and posts run `n` with these findings for each batch. */
  async function review(h: ReturnType<typeof harness>, n: number, found: Finding[] = []) {
    const prepared = await prepare(h.deps, JOB, exec(n), SETTINGS);
    for (const batch of prepared.batches) {
      h.objects.set(
        runKeys(prepared.runId).batchOutput(batch.index),
        JSON.stringify(output({ index: batch.index, findings: found })),
      );
    }
    return { prepared, posted: await post(h.deps, prepared.runId) };
  }

  const promptOf = (h: ReturnType<typeof harness>, id: string, index = 0) =>
    (JSON.parse(h.objects.get(runKeys(id).batchInput(index)) ?? "{}") as { prompt?: string })
      .prompt ?? "";
  const reviews = (h: ReturnType<typeof harness>) => shadowRecords(h.objects, "review").length;

  beforeEach(async () => {
    // The base has src/other.ts too, so the PR modifies it.
    await git(work, "checkout", "--quiet", "main");
    baseSha = await commit({ "src/other.ts": OTHER }, "base other");
    await git(work, "checkout", "--quiet", "feature");
    await git(work, "rebase", "--quiet", "main");
    await git(work, "push", "--quiet", "--force", "--all", "origin");
    headSha = await git(work, "rev-parse", "HEAD");
  });

  it("reviews only the files changed since the last review", async () => {
    const h = harness();
    await addOther();
    await review(h, 1);
    const first = headSha;
    headSha = await commit({ "src/other.ts": "export const rate = 4;\n" }, "again");

    const { prepared } = await review(h, 2);

    expect(h.runs.runs.get(prepared.runId)).toMatchObject({ kind: "incremental", fromSha: first });
    expect(promptOf(h, prepared.runId)).toContain("src/other.ts");
    expect(promptOf(h, prepared.runId)).not.toContain("src/total.ts");
  });

  it("posts no review when nothing new is found, but records the head and keeps the decision", async () => {
    const h = harness();
    await addOther();
    const { posted: first } = await review(h, 1, [finding()]);
    expect(first).toMatchObject({ event: "REQUEST_CHANGES", reviewed: true });
    headSha = await commit({ "src/other.ts": "export const rate = 5;\n" }, "unrelated");

    const { posted } = await review(h, 2);

    // The loop finding's line is untouched, so it stays open and still requests changes.
    expect(posted).toMatchObject({ event: "REQUEST_CHANGES", findings: 0, reviewed: false });
    expect(reviews(h)).toBe(1);
    expect(h.runs.pr).toMatchObject({ lastReviewedSha: headSha, statusLabel: expect.any(String) });
    expect(shadowRecords(h.objects, "summary-comment")).toHaveLength(2);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("marks a finding outdated once its line changes, and approves", async () => {
    const h = harness();
    await review(h, 1, [finding()]);
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("sum += items[i].price;", "sum += items[i].price ?? 0;"),
      },
      "touch other line",
    );
    // Line 3 (the loop) is untouched: still open.
    expect((await review(h, 2)).posted).toMatchObject({
      event: "REQUEST_CHANGES",
      reviewed: false,
    });

    headSha = await commit(
      { "src/total.ts": TOTAL.replace("i < items.length; i++", "i <= items.length - 1; i++") },
      "fix",
    );
    const { posted } = await review(h, 3);

    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(posted).toMatchObject({ event: "APPROVE", reviewed: true });
    expect(reviews(h)).toBe(2);
  });

  it("reopens a finding raised again where its line moved to", async () => {
    const h = harness();
    await review(h, 1, [finding()]);
    // The loop line is rewritten with a new variable name: its old line is gone, but the same
    // problem (same fingerprint: names don't count) is found on the new one.
    const renamed = HEAD_TOTAL.replaceAll("[i]", "[j]").replace(
      "let i = 0; i < items.length - 1; i++",
      "let j = 0; j < items.length - 1; j++",
    );
    headSha = await commit({ "src/total.ts": renamed }, "rename");
    const again = { ...finding(), evidence: "for (let j = 0; j < items.length - 1; j++) {" };

    const { posted } = await review(h, 2, [again]);

    expect(posted).toMatchObject({ event: "REQUEST_CHANGES", findings: 1 });
    expect(h.findings.rows).toMatchObject([{ status: "open", raisedAtSha: headSha }]);
  });

  it("falls back to a full review after a force-push, skipping files whose blob didn't change", async () => {
    const h = harness();
    await addOther();
    const { prepared: first } = await review(h, 1);
    // Rewrite the branch: same src/total.ts, a new src/other.ts, and the old head collected.
    const old = headSha;
    await git(work, "reset", "--quiet", "--hard", baseSha);
    headSha = await commit(
      {
        "src/total.ts": TOTAL.replace("i < items.length; i++", "i < items.length - 1; i++"),
        "src/other.ts": "export const rate = 9;\n",
      },
      "rewritten",
    );
    await git(remote, "reflog", "expire", "--expire=now", "--all");
    await git(remote, "gc", "--quiet", "--prune=now");

    const { prepared } = await review(h, 2);

    expect(h.runs.runs.get(prepared.runId)).toMatchObject({ kind: "full", fromSha: undefined });
    expect(h.logs).toContain("prepared");
    expect(promptOf(h, prepared.runId)).toContain("src/other.ts");
    expect(promptOf(h, prepared.runId)).not.toContain("src/total.ts");
    expect(
      h.runs.runs
        .get(first.runId)
        ?.files.map((file) => file.path)
        .toSorted(),
    ).toEqual(["src/other.ts", "src/total.ts"]);
    expect(old).not.toBe(headSha);
  });

  it("picks up a stopped run's finished batch: skips its unchanged files and posts its findings", async () => {
    const h = harness();
    await addOther();
    const stopped = await prepare(h.deps, JOB, exec(1), SETTINGS);
    h.objects.set(runKeys(stopped.runId).batchOutput(0), JSON.stringify(output()));
    await h.deps.runs.supersedeRun(stopped.runId);
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "newer push");

    const { prepared, posted } = await review(h, 2);

    expect(promptOf(h, prepared.runId)).not.toContain("src/total.ts");
    expect(posted).toMatchObject({ event: "REQUEST_CHANGES", findings: 1, reviewed: true });
    expect(h.runs.runs.get(stopped.runId)?.files.map((file) => file.path)).toContain(
      "src/total.ts",
    );
  });

  it("reviews a file again rather than lose findings from a run too far back to pick up", async () => {
    const h = harness();
    await addOther();
    const first = await prepare(h.deps, JOB, exec(1), SETTINGS);
    h.objects.set(runKeys(first.runId).batchOutput(0), JSON.stringify(output()));
    await h.deps.runs.supersedeRun(first.runId);
    // Newer pushes to src/other.ts, each stopped after its batch: src/total.ts stays done.
    for (let n = 2; n <= 1 + RESUME_RUNS; n++) {
      headSha = await commit({ "src/other.ts": `export const rate = ${10 + n};\n` }, `push ${n}`);
      const stopped = await prepare(h.deps, JOB, exec(n), SETTINGS);
      expect(promptOf(h, stopped.runId)).not.toContain("src/total.ts");
      h.objects.set(
        runKeys(stopped.runId).batchOutput(0),
        JSON.stringify(output({ findings: [] })),
      );
      await h.deps.runs.supersedeRun(stopped.runId);
    }
    headSha = await commit({ "src/other.ts": "export const rate = 99;\n" }, "last push");

    // The first run, the only one with the finding, is now out of reach.
    const { prepared } = await review(h, 9);
    expect(promptOf(h, prepared.runId)).toContain("src/total.ts");
  });

  it("reviews no batch when the head is the one reviewed last", async () => {
    const h = harness();
    await review(h, 1);
    const { prepared, posted } = await review(h, 2);
    expect(prepared.batches).toEqual([]);
    expect(posted).toMatchObject({ event: "APPROVE", reviewed: false });
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
