import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { severityRank, type Finding } from "@lgtmoose/core";
import { cloneAtSha } from "@lgtmoose/git";
import { runKeys, type BatchOutput, type PullReader, type PullRequest } from "@lgtmoose/pipeline";
import { ShadowPoster } from "@lgtmoose/poster";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tarArchive } from "./aws.js";
import type { ReviewThread } from "./threads.js";
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
import { RESUME_RUNS, prepare, readManifest, type RunManifest } from "./prepare.js";
import { PREPARE_FAILED, runCommand } from "./run.js";

const exec = promisify(execFile);
/** Hooks that set up real repositories (clones, commits, pushes) can be slow under load. */
const HOOK_TIMEOUT = 30_000;
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
}, HOOK_TIMEOUT);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    rule_category: "correctness",
    severity: "blocking",
    path: "src/total.ts",
    line: 3,
    side: "RIGHT",
    title: "Loop skips the last item",
    body: "The bound drops the last item from the total.",
    evidence: LOOP,
    ...overrides,
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
      lastReviewEvent: pr.lastReviewEvent,
      lastReviewId: pr.lastReviewId,
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
        lastReviewEvent: undefined,
        lastReviewId: undefined,
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
      // The latest posted run's record of each path, with that run's head.
      const latest = new Map<string, FileRecord & { reviewedAt: string }>();
      for (const run of runs.values()) {
        if (run.status !== "succeeded" || run.result === undefined) continue;
        for (const file of run.files) {
          latest.set(file.path, { ...file, reviewedAt: run.result.reviewedSha });
        }
      }
      return [...latest.values()];
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
        lastReviewedSha: result.reviewedSha,
        ...(result.review === undefined
          ? {}
          : { lastReviewEvent: result.review.event, lastReviewId: result.review.id }),
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

/** A stored finding: tracked while open or outdated, kept once a person resolves or declines it. */
type StoredFinding = Omit<FindingRecord, "status"> & {
  status: FindingRecord["status"] | "resolved_by_human" | "declined";
};

/** `findings` for one PR, like `drizzleFindingStore`. */
function memoryFindings(): FindingStore & { rows: StoredFinding[] } {
  const rows: StoredFinding[] = [];
  return {
    rows,
    async trackedFindings() {
      return rows.flatMap((row) =>
        row.status === "resolved_by_human" || row.status === "declined"
          ? []
          : [{ ...row, status: row.status }],
      );
    },
    async closedFindings() {
      return rows.flatMap(({ status, ...row }) =>
        status === "resolved_by_human" || status === "declined" ? [row] : [],
      );
    },
    async saveFindings(_pr, _run, headSha, posted) {
      for (const { finding, fingerprint, githubCommentId } of posted) {
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
          githubCommentId,
        };
        const at = rows.findIndex((known) => known.fingerprint === fingerprint);
        const known = rows[at];
        if (known === undefined) rows.push(row);
        else if (known.status !== "resolved_by_human" && known.status !== "declined") {
          rows[at] = {
            ...row,
            id: known.id,
            // Never lowered; the comment ID kept unless there's a new one.
            severity:
              severityRank(known.severity) < severityRank(row.severity)
                ? known.severity
                : row.severity,
            // Reopened from outdated: the new comment or none; still open: kept unless new.
            githubCommentId:
              known.status === "open"
                ? (githubCommentId ?? known.githubCommentId)
                : githubCommentId,
          };
        }
      }
    },
    async markOutdated(ids) {
      for (const row of rows)
        if (ids.includes(row.id) && row.status === "open") row.status = "outdated";
    },
    async reopen(ids) {
      for (const row of rows)
        if (ids.includes(row.id) && row.status === "outdated") row.status = "open";
    },
    async syncThreads(_pr, threads) {
      let resolved = 0;
      let unresolved = 0;
      for (const thread of threads) {
        for (const row of rows) {
          if (thread.firstCommentId === undefined || row.githubCommentId !== thread.firstCommentId)
            continue;
          if (thread.resolved && row.status !== "resolved_by_human") {
            row.status = "resolved_by_human";
            resolved++;
          } else if (!thread.resolved && row.status === "resolved_by_human") {
            row.status = "open";
            unresolved++;
          }
        }
      }
      return { resolved, unresolved };
    },
    async escalate(changes) {
      for (const { id, severity } of changes) {
        const row = rows.find((known) => known.id === id && known.status === "open");
        if (row !== undefined && severityRank(severity) < severityRank(row.severity)) {
          row.severity = severity;
        }
      }
    },
  };
}

interface Setup {
  /** The head the PR is at when it's read. */
  head?: string;
  /** The PR's review threads, as GitHub GraphQL would return them; none by default. */
  threads?: () => ReviewThread[];
  /** Give each inline comment posted an ID (as GitHub does), from 1000 up. */
  commentIds?: boolean;
  /** What GitHub says about any review; unset for a reader that can't tell. */
  review?: () => { state: string; commitId: string };
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
  /** The review IDs read from GitHub. */
  const reviewReads: number[] = [];
  const logFields: Record<string, unknown>[] = [];
  /** What each `fetchCommits` on a clone asked for. */
  const fetched: string[][] = [];
  const { review: reviewOf } = setup;
  let nextComment = 1000;
  const reader: PullReader = {
    pull: async () => pull(setup.head ?? headSha),
    comments: async () => [],
    ...(reviewOf === undefined
      ? {}
      : {
          review: async (_target: unknown, id: number) => {
            reviewReads.push(id);
            return reviewOf();
          },
        }),
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
        threads: { reviewThreads: async () => setup.threads?.() ?? [] },
        token: async () => "",
        poster: (runId) => {
          const shadow = new ShadowPoster({
            store: { put: (key, body) => store.putText(key, body) },
            runId,
          });
          if (setup.commentIds !== true) return shadow;
          return Object.assign(Object.create(shadow) as ShadowPoster, {
            async submitReview(...args: Parameters<ShadowPoster["submitReview"]>) {
              const review = await shadow.submitReview(...args);
              return { ...review, commentIds: review.payload.comments.map(() => nextComment++) };
            },
          });
        },
      };
    },
    async clone(options) {
      const repo = await cloneAtSha(options);
      return {
        ...repo,
        async fetchCommits(shas) {
          const list = [...shas];
          fetched.push(list);
          await repo.fetchCommits(list);
        },
      };
    },
    cloneUrl: () => pathToFileURL(remote).href,
    async workDir() {
      const dir = await mkdtemp(join(root, "task-"));
      return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
    },
    archive: tarArchive,
    log: (message, fields) => {
      logs.push(message);
      logFields.push({ message, ...fields });
    },
  };
  return {
    deps,
    objects,
    files,
    runs,
    findings,
    tokens,
    installations,
    logs,
    logFields,
    fetched,
    setup,
    reviewReads,
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
      result: { filesDone: 1, reviewedSha: headSha, review: { event: "REQUEST_CHANGES" } },
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

// Each test makes several real clones and pushes: give them room on a loaded machine.
describe("later runs", { timeout: 30_000 }, () => {
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
  }, HOOK_TIMEOUT);

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
    // Read again: the reviewer raises it again, so it stands.
    expect((await review(h, 2, [finding()])).posted).toMatchObject({
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

  it("follows our comment's thread: resolved takes the finding out, unresolved puts it back", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    const first = await review(h, 1, [finding()]);
    expect(first.posted).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(h.findings.rows).toMatchObject([{ status: "open", githubCommentId: 1000 }]);

    // A person resolves the thread; the next run approves, with the finding left alone.
    threads = [{ resolved: true, firstCommentId: 1000 }];
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "unrelated");
    const resolved = await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);
    expect(resolved.posted).toMatchObject({ event: "APPROVE" });

    // The reviewer raises it again: the person's decision wins. Not posted, not counted.
    headSha = await commit({ "src/other.ts": "export const rate = 8;\n" }, "unrelated, again");
    const reraised = await review(h, 3, [finding()]);
    expect(reraised.posted).toMatchObject({ event: "APPROVE", findings: 0 });
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);

    // Still after the file is renamed: it's followed to the new name, and matched there.
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    headSha = await commit({}, "rename");
    const renamed = await review(h, 4, [finding({ path: "src/sum.ts" })]);
    expect(renamed.posted).toMatchObject({ event: "APPROVE", findings: 0 });
    expect(h.findings.rows).toHaveLength(1);
    await git(work, "mv", "src/sum.ts", "src/total.ts");
    headSha = await commit({}, "rename back");

    // Unresolved again: back in the decision.
    threads = [{ resolved: false, firstCommentId: 1000 }];
    headSha = await commit({ "src/other.ts": "export const rate = 7;\n" }, "unrelated again");
    const reopened = await review(h, 5);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(reopened.posted).toMatchObject({ event: "REQUEST_CHANGES" });
  });

  it("leaves findings as they are when the review threads can't be read", async () => {
    const h = harness({
      commentIds: true,
      threads: () => {
        throw new Error("GraphQL is down");
      },
    });
    await review(h, 1, [finding()]);
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "unrelated");
    const second = await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(second.posted).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(h.logs).toContain("review threads unread");
  });

  it("keeps a finding open when the reviewer is quiet about it after a nearby edit", async () => {
    const h = harness();
    await review(h, 1, [finding({ severity: "should_fix" })]);
    // Another line of the block changes, so the file is read again; the loop line is untouched.
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("sum += items[i].price;", "sum += items[i].price ?? 0;"),
      },
      "touch another line",
    );

    // Told not to repeat our comments, the reviewer says nothing: that doesn't clear it.
    const quiet = await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "open", severity: "should_fix" }]);
    expect(quiet.posted).not.toMatchObject({ event: "APPROVE" });

    // Raised again more severely: not posted again, stored and counted as blocking.
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("sum += items[i].price;", "sum += items[i].price ?? 1;"),
      },
      "touch it again",
    );
    const again = await review(h, 3, [finding()]);
    expect(h.findings.rows).toMatchObject([{ status: "open", severity: "blocking" }]);
    expect(again.posted).toMatchObject({ event: "REQUEST_CHANGES", findings: 0 });
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

  it("matches a re-raise to a finding kept at its place after a force-push", async () => {
    const h = harness();
    await review(h, 1, [finding({ severity: "should_fix" })]);
    // Rewrite the branch: the commit the finding was raised at is gone, the loop line stays.
    await git(work, "reset", "--quiet", "--hard", baseSha);
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("sum += items[i].price;", "sum += items[i].price ?? 0;"),
      },
      "rewritten",
    );
    await git(remote, "reflog", "expire", "--expire=now", "--all");
    await git(remote, "gc", "--quiet", "--prune=now");

    // Its line can't be followed, so it's kept where it was; the code there is still its code,
    // so a reworded re-raise is matched to it (and raises its severity) rather than posted.
    const again = await review(h, 2, [finding({ title: "Loop skips the final item" })]);
    expect(again.posted).toMatchObject({ findings: 0 });
    expect(h.findings.rows).toMatchObject([{ status: "open", severity: "blocking" }]);
  });

  it("doesn't follow a closed finding on a file the PR no longer changes", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    await review(h, 1, [finding()]);
    const raisedAt = headSha;
    threads = [{ resolved: true, firstCommentId: 1000 }];
    // src/total.ts back as the base has it: the PR no longer changes it.
    headSha = await commit({ "src/total.ts": TOTAL }, "revert total");
    await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);
    expect(h.fetched.flat()).not.toContain(raisedAt);
  });

  it("skips an unreadable earlier manifest instead of failing the run", async () => {
    const h = harness();
    await addOther();
    const stopped = await prepare(h.deps, JOB, exec(1), SETTINGS);
    await h.deps.runs.supersedeRun(stopped.runId);
    h.objects.set(runKeys(stopped.runId).prepared, JSON.stringify({ version: 9 }));
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "newer push");

    const { prepared } = await review(h, 2);

    expect(promptOf(h, prepared.runId)).toContain("src/total.ts");
    expect(h.logs).toContain("skipped an unreadable earlier manifest");
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
    // Nothing is recorded for the stopped run: only posted runs' files count as reviewed.
    expect(h.runs.runs.get(stopped.runId)?.files).toEqual([]);
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

  it("reviews no batch and posts no second approval when the head is the one reviewed last", async () => {
    const h = harness();
    await review(h, 1);
    const { prepared, posted } = await review(h, 2);
    expect(prepared.batches).toEqual([]);
    expect(posted).toMatchObject({ event: "APPROVE", reviewed: false });
    expect(reviews(h)).toBe(1);
  });

  it("posts no second approval only while GitHub has it as approved on this head", async () => {
    const cases = [
      // Still approved, on this commit: nothing to post.
      { state: "APPROVED", onHead: true, push: false, again: false },
      // Dismissed without a push: approve again.
      { state: "DISMISSED", onHead: true, push: false, again: true },
      // After a push the approval is of an older commit: approve the latest push.
      { state: "APPROVED", onHead: false, push: true, again: true },
    ];
    for (const { state, onHead, push, again } of cases) {
      const reviewed = headSha;
      const h = harness({
        review: () => ({ state, commitId: onHead ? headSha : reviewed }),
      });
      await review(h, 1);
      // Shadow mode has no review IDs; a real poster records GitHub's.
      h.runs.pr.lastReviewId = 900;
      if (push) {
        headSha = await commit({ "src/other.ts": "export const rate = 11;\n" }, "push");
      }

      const { posted } = await review(h, 2);

      expect(posted).toMatchObject({ event: "APPROVE", reviewed: again });
      expect(h.reviewReads).toEqual([900]);
    }
  });

  it("approves again after a push when it can't tell whether the approval stands", async () => {
    const h = harness();
    await review(h, 1);
    headSha = await commit({ "src/other.ts": "export const rate = 8;\n" }, "push");
    expect((await review(h, 2)).posted).toMatchObject({ event: "APPROVE", reviewed: true });
  });

  it("reviews a failed batch's files on later runs, though the range moves on", async () => {
    const h = harness();
    const first = headSha;
    // No batch output: the batch failed. The head still becomes the start of the next range.
    const failed = await prepare(h.deps, JOB, exec(1), SETTINGS);
    expect((await post(h.deps, failed.runId)).complete).toBe(false);
    expect(h.runs.pr.lastReviewedSha).toBe(first);
    headSha = await commit({ "src/other.ts": "export const rate = 7;\n" }, "unrelated");

    // Fails again: src/total.ts is still unreviewed, however many runs go by.
    const again = await prepare(h.deps, JOB, exec(2), SETTINGS);
    expect(promptOf(h, again.runId)).toContain("src/total.ts");
    // Nothing has been reviewed yet, so there is nothing to compare with: still a full review.
    expect(h.runs.runs.get(again.runId)).toMatchObject({ kind: "full" });
    await post(h.deps, again.runId);
    headSha = await commit({ "src/other.ts": "export const rate = 17;\n" }, "unrelated again");

    const { prepared } = await review(h, 3);
    expect(promptOf(h, prepared.runId)).toContain("src/total.ts");

    // Once it's been reviewed, it's done.
    headSha = await commit({ "src/other.ts": "export const rate = 27;\n" }, "and again");
    const { prepared: after } = await review(h, 4);
    expect(promptOf(h, after.runId)).not.toContain("src/total.ts");
  });

  it("reviews a file again when it returns to a blob whose finding was marked outdated", async () => {
    const h = harness();
    await review(h, 1, [finding()]);
    headSha = await commit(
      { "src/total.ts": TOTAL.replace("i < items.length; i++", "i <= items.length - 1; i++") },
      "fix",
    );
    expect((await review(h, 2)).posted).toMatchObject({ event: "APPROVE" });
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    // Revert the fix: src/total.ts is back at the blob run 1 reviewed.
    headSha = await commit({ "src/total.ts": HEAD_TOTAL }, "revert the fix");

    const { prepared, posted } = await review(h, 3, [finding()]);

    expect(promptOf(h, prepared.runId)).toContain("src/total.ts");
    // The outdated finding's line is back, so it reopens; the model's repeat isn't posted twice.
    expect(posted).toMatchObject({ event: "REQUEST_CHANGES", findings: 0 });
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("reopens an outdated finding when its line comes back without the file being reviewed", async () => {
    const h = harness();
    await review(h, 1, [finding()]);
    const reviewed = headSha;
    headSha = await commit(
      { "src/total.ts": TOTAL.replace("i < items.length; i++", "i <= items.length - 1; i++") },
      "fix",
    );
    // The fix's run has a failed batch (no output), so the head it reviewed isn't recorded.
    const fixRun = await prepare(h.deps, JOB, exec(2), SETTINGS);
    await post(h.deps, fixRun.runId);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(reviewed).not.toBe(h.runs.pr.lastReviewedSha);
    // Revert the fix: src/total.ts is as it was at the reviewed head, so nothing is in range.
    headSha = await commit({ "src/total.ts": HEAD_TOTAL }, "revert the fix");

    const { prepared, posted } = await review(h, 3);

    expect(prepared.batches).toEqual([]);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(posted.event).toBe("REQUEST_CHANGES");
  });

  it("posts a review when the event changes though the label doesn't", async () => {
    const h = harness();
    const shouldFix = finding({
      severity: "should_fix",
      line: 6,
      title: "Sum isn't rounded",
      evidence: "return sum;",
    });
    await review(h, 1, [finding(), shouldFix]);
    // Fix the blocking loop; the should-fix line stays.
    headSha = await commit(
      { "src/total.ts": TOTAL.replace("i < items.length; i++", "i <= items.length - 1; i++") },
      "fix",
    );

    // The reviewer raises the should-fix one again; the loop finding is gone with its line.
    const { posted } = await review(h, 2, [shouldFix]);

    // Same "changes" label, but REQUEST_CHANGES became COMMENT: the old review must not stand.
    expect(posted).toMatchObject({ event: "COMMENT", findings: 0, reviewed: true });
    expect(reviews(h)).toBe(2);
    expect(h.runs.pr.lastReviewEvent).toBe("COMMENT");
  });

  it("reopens an outdated old-side finding only once the PR deletes its line again", async () => {
    const h = harness();
    // The PR deletes "return sum;" (line 6 of the base): a finding on the deleted line.
    const without = HEAD_TOTAL.replace("  return sum;\n", "");
    headSha = await commit({ "src/total.ts": without }, "drop the return");
    const left = finding({
      side: "LEFT",
      line: 6,
      title: "Return was removed",
      evidence: "return sum;",
    });
    await review(h, 1, [left]);
    // Put the return back: the PR no longer deletes the line, so the finding is outdated.
    headSha = await commit({ "src/total.ts": HEAD_TOTAL }, "restore the return");
    await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    // The file is still in the PR (its loop change), but line 6 isn't deleted: stays outdated.
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("let sum = 0;", "let sum = 0; // start") },
      "touch another line",
    );
    await review(h, 3);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);

    headSha = await commit({ "src/total.ts": without }, "drop the return again");
    // Deleted again: it reopens, and the reviewer, reading the file again, raises it again.
    await review(h, 4, [left]);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("keeps an old-side finding whose raised-at commit shares no history with the base", async () => {
    const h = harness();
    const left = finding({
      side: "LEFT",
      line: 3,
      title: "Old bound was right",
      evidence: "for (let i = 0; i < items.length; i++) {",
    });
    await review(h, 1, [left]);
    // A commit with no history in common with the PR (an orphan branch on the remote).
    await git(work, "checkout", "--quiet", "--orphan", "unrelated");
    const orphan = await commit({ "x.txt": "x\n" }, "orphan");
    await git(work, "checkout", "--quiet", "feature");
    const row = h.findings.rows[0];
    if (row === undefined) throw new Error("expected a recorded finding");
    row.raisedAtSha = orphan;
    headSha = await commit({ "src/other.ts": "export const rate = 4;\n" }, "unrelated push");

    await expect(review(h, 2)).resolves.toBeDefined();
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("reviews a push that only deletes a base line, instead of approving it as covered", async () => {
    const h = harness();
    await review(h, 1);
    expect(h.runs.pr.lastReviewEvent).toBe("APPROVE");
    // Only deletes a line the base has: the PR adds nothing new.
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("    sum += items[i].price;\n", "") },
      "drop a base line",
    );

    const { prepared } = await review(h, 2);

    expect(prepared.batches).toHaveLength(1);
    const prompt = promptOf(h, prepared.runId);
    expect(prompt).toContain("src/total.ts");
    expect(prompt).toContain("Deleted since the last review: LEFT line 4.");
  });

  it("doesn't review a file again when only a base merge changed its blob", async () => {
    const h = harness();
    await addOther();
    await review(h, 1);
    // main appends to src/total.ts, far from the PR's change, and the PR merges main.
    await git(work, "checkout", "--quiet", "main");
    baseSha = await commit({ "src/total.ts": `${TOTAL}export const unit = 1;\n` }, "main edit");
    await git(work, "checkout", "--quiet", "feature");
    await git(work, "merge", "--quiet", "--no-edit", "main");
    await git(work, "push", "--quiet", "--force", "--all", "origin");
    headSha = await git(work, "rev-parse", "HEAD");

    const { prepared } = await review(h, 2);

    expect(h.runs.runs.get(prepared.runId)).toMatchObject({ kind: "incremental" });
    expect(prepared.batches).toEqual([]);
  });

  it("reviews what a failed batch's files stopped adding, on a later run", async () => {
    const h = harness();
    const CHECK = "  if (items.length === 0) return 0;\n";
    // Run 1 reviews a check the PR adds, and a change to src/other.ts.
    const withCheck = HEAD_TOTAL.replace("  let sum = 0;\n", `  let sum = 0;\n${CHECK}`);
    headSha = await commit(
      { "src/total.ts": withCheck, "src/other.ts": "export const rate = 3;\n" },
      "add a check",
    );
    await review(h, 1);
    // The next push drops the check and reverts src/other.ts; that run's batch fails.
    headSha = await commit({ "src/total.ts": HEAD_TOTAL, "src/other.ts": OTHER }, "drop them");
    const failed = await prepare(h.deps, JOB, exec(2), SETTINGS);
    await post(h.deps, failed.runId);
    expect(h.runs.pr.lastReviewedSha).toBe(headSha);
    // A later, unrelated push: both are still compared with run 1's review.
    headSha = await commit({ "src/new.ts": "export const later = true;\n" }, "later");

    const { prepared } = await review(h, 3);

    const prompt = promptOf(h, prepared.runId);
    expect(prompt).toContain("src/total.ts");
    expect(prompt).toContain("if (items.length === 0) return 0;");
    expect(prompt).toContain("no longer adds");
    // src/other.ts is back as the base has it: nothing to review. Its revert needs no batch,
    // so run 2's summary already reported what it no longer adds.
    expect(prompt).not.toContain("src/other.ts");
    const summaries = JSON.stringify(shadowRecords(h.objects, "summary-comment"));
    expect(summaries).toContain("No longer changed by the PR");
    expect(summaries).toMatch(/other\\+\.ts/);
  });

  it("follows an old-side finding on a renamed file across base edits", async () => {
    const h = harness();
    // The PR renames src/total.ts and deletes its return; main later edits the file's top.
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    headSha = await commit({ "src/sum.ts": HEAD_TOTAL.replace("  return sum;\n", "") }, "rename");
    const left = finding({
      path: "src/sum.ts",
      side: "LEFT",
      line: 6,
      title: "Return was removed",
      evidence: "return sum;",
    });
    await review(h, 1, [left]);
    await git(work, "checkout", "--quiet", "main");
    baseSha = await commit({ "src/total.ts": `// header\n// more\n${TOTAL}` }, "main edit");
    await git(work, "checkout", "--quiet", "feature");
    await git(work, "merge", "--quiet", "--no-edit", "main");
    await git(work, "push", "--quiet", "--force", "--all", "origin");
    headSha = await git(work, "rev-parse", "HEAD");

    // If the reviewer reads the file again, it raises the finding again where the line is now.
    await review(h, 2, [{ ...left, line: 8 }]);

    // Still deleted, two lines further down the base.
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("places an old-side finding under the file's new name after the PR renames it", async () => {
    const h = harness();
    // The PR deletes the return, and is reviewed; then it renames the file.
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("  return sum;\n", "") },
      "drop return",
    );
    const left = finding({
      side: "LEFT",
      line: 6,
      title: "Return was removed",
      evidence: "return sum;",
    });
    await review(h, 1, [left]);
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    headSha = await commit({}, "rename");

    // Raised again under the new name: the same finding, not posted again.
    const again = await review(h, 2, [{ ...left, path: "src/sum.ts" }]);
    expect(again.posted).toMatchObject({ findings: 0 });
    expect(h.findings.rows).toMatchObject([{ status: "open", path: "src/total.ts" }]);
  });

  it("keeps a finding under the file's new name when its commit is gone and the PR renamed it", async () => {
    const h = harness();
    await review(h, 1, [finding({ severity: "should_fix" })]);
    // Rewrite the branch: the commit the finding was raised at is gone, and the PR now renames
    // the file (same change otherwise).
    await git(work, "reset", "--quiet", "--hard", baseSha);
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    headSha = await commit({ "src/sum.ts": HEAD_TOTAL }, "rewritten with a rename");
    await git(remote, "reflog", "expire", "--expire=now", "--all");
    await git(remote, "gc", "--quiet", "--prune=now");

    // Kept at its line under the new name: a reworded re-raise there is matched to it.
    const again = await review(h, 2, [
      finding({ path: "src/sum.ts", title: "Loop skips the final item" }),
    ]);
    expect(h.findings.rows).toMatchObject([{ status: "open", severity: "blocking" }]);
    expect(again.posted).toMatchObject({ findings: 0 });
  });

  it("follows an old-side finding when the base renames the file and the PR is rebased", async () => {
    const h = harness();
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("  return sum;\n", "") },
      "drop return",
    );
    const left = finding({
      side: "LEFT",
      line: 6,
      title: "Return was removed",
      evidence: "return sum;",
    });
    await review(h, 1, [left]);
    // Main renames the file; the PR is rebased onto it, so it now deletes the return in
    // src/sum.ts.
    await git(work, "checkout", "--quiet", "main");
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    baseSha = await commit({}, "main: rename");
    await git(work, "checkout", "--quiet", "feature");
    await git(work, "rebase", "--quiet", "main");
    await git(work, "push", "--quiet", "--force", "--all", "origin");
    headSha = await git(work, "rev-parse", "HEAD");

    await review(h, 2);
    // Still deleted, under the base's new name: it stands.
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    // Raised again there: the same finding.
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "unrelated");
    const again = await review(h, 3, [{ ...left, path: "src/sum.ts" }]);
    expect(again.posted).toMatchObject({ findings: 0 });
  });

  it("follows a resolved finding when the base renames its file and the PR is rebased", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    await review(h, 1, [finding()]);
    threads = [{ resolved: true, firstCommentId: 1000 }];
    // Main renames the file; the PR is rebased onto it, its change now in src/sum.ts.
    await git(work, "checkout", "--quiet", "main");
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    baseSha = await commit({}, "main: rename");
    await git(work, "checkout", "--quiet", "feature");
    await git(work, "rebase", "--quiet", "main");
    await git(work, "push", "--quiet", "--force", "--all", "origin");
    headSha = await git(work, "rev-parse", "HEAD");

    // Raised again under the new name: the person's decision still wins.
    const again = await review(h, 2, [finding({ path: "src/sum.ts" })]);
    expect(again.posted).toMatchObject({ event: "APPROVE", findings: 0 });
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);
  });

  it("follows a resolved finding on a file the PR added and then renamed", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    headSha = await commit({ "src/rates.ts": "export const rate = 1 / 0;\n" }, "add rates");
    const added = finding({
      path: "src/rates.ts",
      line: 1,
      title: "Rate divides by zero",
      evidence: "1 / 0",
    });
    await review(h, 1, [added]);
    threads = [{ resolved: true, firstCommentId: 1000 }];
    await git(work, "mv", "src/rates.ts", "src/rate.ts");
    headSha = await commit({}, "rename rates");

    const again = await review(h, 2, [{ ...added, path: "src/rate.ts" }]);
    expect(again.posted).toMatchObject({ event: "APPROVE", findings: 0 });
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);
  });

  it("follows a resolved finding on a rewritten file the PR then renames with a small edit", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    // The PR rewrites src/total.ts: against the base, nothing of it is left.
    const rewritten = [
      "export function grandTotal(orders: Order[]): number {",
      "  return orders.reduce((all, order) => all + order.amount * order.rate, 0);",
      "}",
      "",
      "export function averageOrder(orders: Order[]): number {",
      "  return grandTotal(orders) / orders.length;",
      "}",
      "",
    ].join("\n");
    headSha = await commit({ "src/total.ts": rewritten }, "rewrite total");
    const average = finding({
      line: 6,
      title: "Average divides by zero for no orders",
      evidence: "grandTotal(orders) / orders.length",
    });
    await review(h, 1, [average]);
    threads = [{ resolved: true, firstCommentId: 1000 }];
    // Renamed with a small edit: against the base it's a deletion and an addition, but a rename
    // since the finding's commit.
    await git(work, "mv", "src/total.ts", "src/orders.ts");
    headSha = await commit(
      { "src/orders.ts": `// Order totals.\n${rewritten}` },
      "rename to orders.ts",
    );

    const again = await review(h, 2, [{ ...average, path: "src/orders.ts", line: 7 }]);
    expect(again.posted).toMatchObject({ event: "APPROVE", findings: 0 });
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);
  });

  it("skips following findings when there are none", async () => {
    const h = harness();
    await review(h, 1);
    expect(h.fetched).toEqual([]);
  });

  it("reviews a change again when it's re-applied after a full revert", async () => {
    const h = harness();
    await addOther();
    await review(h, 1);
    // Revert src/other.ts to the base: the PR no longer changes it.
    headSha = await commit({ "src/other.ts": OTHER }, "revert other");
    await review(h, 2);
    // Re-apply the reviewed change: the same blob as run 1 saw, but run 2 saw the base's.
    headSha = await commit({ "src/other.ts": "export const rate = 3;\n" }, "re-apply");

    const { prepared } = await review(h, 3);

    expect(promptOf(h, prepared.runId)).toContain("src/other.ts");
  });

  it("fetches the commits of outdated findings only while the PR changes their file", async () => {
    const h = harness();
    await addOther();
    const raised = headSha;
    await review(h, 1, [finding()]);
    // Fix the loop line: the finding goes outdated, but the PR still changes the file.
    headSha = await commit(
      { "src/total.ts": TOTAL.replace("i < items.length; i++", "i <= items.length - 1; i++") },
      "fix",
    );
    await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(h.fetched.at(-1)).toEqual([raised]);
    // Revert src/total.ts to the base: the PR leaves it alone, so the finding isn't followed.
    headSha = await commit({ "src/total.ts": TOTAL }, "leave total.ts alone");
    await review(h, 3);
    expect(h.fetched.at(-1)).toEqual([]);
  });

  it("logs carried batches and carried findings separately", async () => {
    const h = harness();
    await addOther();
    const stopped = await prepare(h.deps, JOB, exec(1), SETTINGS);
    const two = [
      finding(),
      finding({ title: "Total isn't rounded", line: 6, evidence: "return sum;" }),
    ];
    h.objects.set(runKeys(stopped.runId).batchOutput(0), JSON.stringify(output({ findings: two })));
    await h.deps.runs.supersedeRun(stopped.runId);
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "newer push");

    await prepare(h.deps, JOB, exec(2), SETTINGS);

    expect(h.logFields.findLast((entry) => entry.message === "prepared")).toMatchObject({
      carriedBatches: 1,
      carriedFindings: 2,
    });
  });

  it("posts a run prepared before incremental reviews (manifest version 1)", async () => {
    const h = harness();
    const prepared = await prepare(h.deps, JOB, exec(1), SETTINGS);
    const key = runKeys(prepared.runId).prepared;
    const manifest = JSON.parse(h.objects.get(key) ?? "{}") as {
      version: number;
      review: Record<string, unknown>;
    };
    for (const field of ["kind", "done", "carried", "unchanged", "noLongerChanged"]) {
      delete manifest.review[field];
    }
    h.objects.set(key, JSON.stringify({ ...manifest, version: 1 }));
    h.objects.set(runKeys(prepared.runId).batchOutput(0), JSON.stringify(output()));

    expect(await post(h.deps, prepared.runId)).toMatchObject({
      event: "REQUEST_CHANGES",
      findings: 1,
    });
  });
});

describe("readManifest", () => {
  const review = { plan: { skipped: [] }, jobs: [] };

  it("refuses unknown versions and version 1 manifests that have incremental fields", () => {
    expect(() => readManifest(JSON.stringify({ version: 3, installationId: 1, review }))).toThrow(
      "Unsupported run manifest",
    );
    expect(() =>
      readManifest(
        JSON.stringify({ version: 1, installationId: 1, review: { ...review, carried: [] } }),
      ),
    ).toThrow("Unsupported run manifest");
  });

  it("refuses a version 2 manifest of another shape", async () => {
    const h = harness();
    const prepared = await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    const text = h.objects.get(runKeys(prepared.runId).prepared) ?? "";
    expect(readManifest(text).version).toBe(2);
    const manifest = JSON.parse(text) as { review: Record<string, unknown> };
    // An earlier build of version 2 kept `done` as paths.
    manifest.review.done = ["src/total.ts"];
    expect(() => readManifest(JSON.stringify(manifest))).toThrow("review.done");
  });

  it("fills in a main-branch version 1 manifest", () => {
    expect(readManifest(JSON.stringify({ version: 1, installationId: 1, review }))).toMatchObject({
      version: 2,
      review: { kind: "full", done: [], carried: [] },
    });
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
