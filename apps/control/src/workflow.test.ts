import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { budgetsSchema } from "@lgtmoose/config";
import { severityRank, type Finding } from "@lgtmoose/core";
import { cloneAtSha } from "@lgtmoose/git";
import {
  headKeys,
  runKeys,
  type BatchOutput,
  type HeadChecks,
  type PullComment,
  type PullReader,
  type PullRequest,
} from "@lgtmoose/pipeline";
import { GitHubError, ShadowPoster, type MarkedReview, type Poster } from "@lgtmoose/poster";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tarArchive } from "./aws.js";
import { GraphQlError, type ReviewThread } from "./threads.js";
import type {
  ArtifactStore,
  ChecksWait,
  ChecksWaitStore,
  FileRecord,
  FindingRecord,
  FindingStore,
  RunRecord,
  RunStore,
} from "./ports.js";
import {
  OFF_ECS_CLAIM_TTL_MS,
  SUMMARY_MARKER,
  countAttempt,
  coveringReviews,
  markerRun,
  post,
  reviewMarker,
  type PostAttempt,
} from "./post.js";
import { RESUME_RUNS, prepare, readManifest, type RunManifest } from "./prepare.js";
import { settleStaleSpend, type SpendSnapshot, type SpendStore } from "./spend.js";
import { POST_FAILED, PREPARE_FAILED, runCommand, type StepDeps } from "./run.js";

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
  /** Its post was in shadow mode (NIC-1141). */
  shadow?: boolean;
  /** When it succeeded, on the test's clock (`tick`). */
  finishedAt?: number;
  covered?: boolean;
  coverResult?: Parameters<RunStore["coverRun"]>[1];
}

/** Run IDs in the order runs start: RUN_ID first. */
const runId = (n: number) =>
  n === 0 ? RUN_ID : `0b6f6d8e-3c1a-4c3e-9a51-${String(n).padStart(12, "0")}`;

/** One PR's runs, like `drizzleRunStore` keeps them. */
function memoryRuns(): RunStore & {
  runs: Map<string, Run>;
  pr: Partial<RunRecord>;
  newer: { posted: boolean };
  /** The automatic-review count, as the test sets it and the prepare step resets it. */
  pause: {
    reviews: number;
    head: string | undefined;
    resets: number;
    arms: string[];
    noted: string[];
  };
} {
  const runs = new Map<string, Run>();
  /** Whether a newer run of the PR has posted, as the test sets it. */
  const newer = { posted: false };
  const pause: {
    reviews: number;
    head: string | undefined;
    resets: number;
    arms: string[];
    noted: string[];
  } = {
    reviews: 0,
    head: undefined,
    resets: 0,
    arms: [],
    noted: [],
  };
  const pr: Partial<RunRecord> = { summaryCommentId: 41 };
  const current = (run: Run): Run =>
    Object.assign(run, {
      summaryCommentId: pr.summaryCommentId,
      lastReviewedSha: pr.lastReviewedSha,
      statusLabel: pr.statusLabel,
      lastReviewEvent: pr.lastReviewEvent,
      lastReviewId: pr.lastReviewId,
      reviewLive: pr.reviewLive,
    });
  return {
    runs,
    pr,
    newer,
    pause,
    async newerRunPosted() {
      return newer.posted;
    },
    async coverRun(runId, result) {
      const run = runs.get(runId);
      if (run) Object.assign(run, { status: "covered", covered: true, coverResult: result });
    },
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
        headSha: input.headSha,
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
          latest.set(file.path, { ...file, reviewedAt: run.result.headSha });
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
      Object.assign(run, { status: "succeeded", result, finishedAt: tick() });
      // A shadow run's review was never on GitHub (NIC-1141): changed only with a review, as the
      // drizzle store does.
      if (result.review !== undefined) {
        if (run.shadow === false) pr.reviewLive = true;
        else delete pr.reviewLive;
      }
      Object.assign(pr, {
        lastReviewedSha: result.headSha,
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
    async automaticReviews() {
      return pause.reviews;
    },
    async resetAutomaticReviews() {
      pause.resets += 1;
      pause.head = undefined;
      pause.reviews = 0;
    },
    async armRequestedReview(_repo, _number, headSha) {
      pause.arms.push(headSha);
      pause.head = headSha;
      pause.reviews = 0;
    },
    async requestedReviewHead() {
      return pause.head;
    },
    async forgetRequestedReview() {
      pause.head = undefined;
    },
    async noteRequestedRun(_repo, _number, runId) {
      pause.noted.push(runId);
      pause.head = undefined;
    },
    async recordShadow(runId, shadow) {
      const run = runs.get(runId);
      if (run !== undefined) run.shadow = shadow;
    },
    async supersedeRun(runId) {
      const run = runs.get(runId);
      if (run?.status === "running") run.status = "superseded";
    },
  };
}

/** A stored finding: tracked while open or outdated, kept once a person resolves or declines it. */
type StoredFinding = Omit<FindingRecord, "status" | "unpostedShadow"> & {
  status:
    FindingRecord["status"] | "resolved_by_human" | "declined" | "fixed" | "disputed" | "shadow";
  /** Last raised by a run in shadow mode (NIC-1141). */
  shadowRun?: boolean;
  /** When it was retired from shadow mode, on the test's clock (`tick`). */
  retiredAt?: number;
};

/** The test's clock: retirements and finished runs, in order. */
let clock = 0;
const tick = () => ++clock;

/** Raised in shadow mode and never posted (`unpostedShadow`; no person's answers here). */
function unposted(row: StoredFinding): boolean {
  return (
    (row.status === "open" || row.status === "outdated") &&
    row.shadowRun === true &&
    row.githubCommentId === undefined
  );
}

/**
 * `findings` for one PR, like `drizzleFindingStore`: `shadowRun` says which runs were shadow, and
 * `lastFullReview` when the latest full review succeeded (`tick`), if one did.
 */
function memoryFindings(
  shadowRun: (runId: string) => boolean = () => false,
  lastFullReview: () => number = () => 0,
): FindingStore & { rows: StoredFinding[] } {
  const rows: StoredFinding[] = [];
  return {
    rows,
    async trackedFindings() {
      return rows.flatMap((stored) => {
        const { status, ...row } = stored;
        if (status !== "open" && status !== "outdated") return [];
        return [{ ...row, status, ...(unposted(stored) ? { unpostedShadow: true } : {}) }];
      });
    },
    async closedFindings() {
      return rows.flatMap(({ status, ...row }) =>
        status === "resolved_by_human" || status === "declined" ? [row] : [],
      );
    },
    async saveFindings(_pr, runId, headSha, posted) {
      for (const { finding, fingerprint, githubCommentId, basePath } of posted) {
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
          basePath,
          ...(shadowRun(runId) ? { shadowRun: true } : {}),
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
            basePath: basePath ?? known.basePath,
            // Reopened from outdated: the new comment or none; still open: kept unless new.
            githubCommentId:
              known.status === "open"
                ? (githubCommentId ?? known.githubCommentId)
                : githubCommentId,
          };
        }
      }
    },
    async retireShadowFindings() {
      const retiring = rows.filter((row) => unposted(row));
      for (const row of retiring) {
        row.status = "shadow";
        row.retiredAt = tick();
      }
      return retiring.length;
    },
    async retiredShadowFindings() {
      return rows
        .filter((row) => row.status === "shadow" && (row.retiredAt ?? 0) > lastFullReview())
        .map((row) => row.fingerprint);
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
  /** The PR's state when it's read. */
  state?: string;
  /** The PR's comments when they're read; none by default. */
  comments?: () => PullComment[];
  /**
   * The `.lgtmoose.yaml` the reader serves at the base, before the clone (`review.trigger`).
   * Left out, the reader can't read files and every run reviews, as before.
   */
  config?: string;
  /** The PR's labels when it's read. */
  labels?: string[];
  /**
   * The head's CI as the reader serves it (`review.wait_for_checks`, NIC-1078), and the base
   * branch's required checks. Left out, the reader can't read checks and no run waits for CI.
   */
  checks?: () => HeadChecks;
  required?: string[];
}

/** `pull_request_dispatches`' wait for CI, in memory, for one PR. */
function memoryChecksWaits() {
  let row: ChecksWait | undefined;
  const store: ChecksWaitStore = {
    async get() {
      return row;
    },
    async wait(_repo, _number, headSha, state, now) {
      const before = row?.headSha === headSha ? { ...row } : undefined;
      row = { headSha, since: before?.since ?? now, state };
      return before;
    },
    async clear() {
      row = undefined;
    },
    // The prepare step reads this one PR with `get`. The dispatcher is what looks up a SHA.
    async byHead() {
      return [];
    },
  };
  return {
    store,
    get row() {
      return row;
    },
    set row(value: ChecksWait | undefined) {
      row = value;
    },
  };
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
  const findings = memoryFindings(
    (id) => runs.runs.get(id)?.shadow === true,
    () =>
      Math.max(
        0,
        ...[...runs.runs.values()]
          .filter(
            (run) => run.kind === "full" && run.status === "succeeded" && run.result?.complete,
          )
          .map((run) => run.finishedAt ?? 0),
      ),
  );
  /** The review IDs read from GitHub. */
  const reviewReads: number[] = [];
  const logFields: Record<string, unknown>[] = [];
  /** What each `fetchCommits` on a clone asked for. */
  const fetched: string[][] = [];
  const { review: reviewOf } = setup;
  let nextComment = 1000;
  /** Our reviews' markers "on GitHub" by commit, as the tests put them there. */
  const reviewsOnGitHub = new Map<string, MarkedReview[]>();
  /** The external IDs of our check runs "on GitHub", as the post or the test put them there. */
  const checkRunsOnGitHub = new Set<string>();
  /** How many annotations each of those has, when not none. */
  const checkRunAnnotations = new Map<string, number>();
  /** ECS task statuses by ARN, as the test sets them. */
  const tasks = new Map<string, string>();
  /** What the reader was asked for with `fileAt`, as `<sha>:<path>`. */
  const fileReads: string[] = [];
  /** How many clones were made. */
  const clones = { count: 0 };
  /** Labels taken off the PR. */
  const removedLabels: string[] = [];
  const { config: configText } = setup;
  const reader: PullReader = {
    pull: async () => ({
      ...pull(setup.head ?? headSha),
      state: setup.state ?? "open",
      ...(setup.labels === undefined ? {} : { labels: [...setup.labels] }),
    }),
    comments: async () => setup.comments?.() ?? [],
    ...(setup.checks === undefined
      ? {}
      : {
          checksAt: async () => (setup.checks as () => HeadChecks)(),
          requiredChecks: async () => [...(setup.required ?? [])],
        }),
    ...(configText === undefined
      ? {}
      : {
          fileAt: async (_target: unknown, sha: string, path: string) => {
            fileReads.push(`${sha}:${path}`);
            return configText;
          },
        }),
    ...(reviewOf === undefined
      ? {}
      : {
          review: async (_target: unknown, id: number) => {
            reviewReads.push(id);
            return reviewOf();
          },
        }),
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
        // `lead` is a maintainer; anyone else has read access.
        permission: async (_target, login) =>
          login === "lead" ? ("maintain" as const) : ("read" as const),
        token: async () => "",
        poster: (runId) => {
          const shadow = new ShadowPoster({
            store: { put: (key, body) => store.putText(key, body) },
            runId,
          });
          if (setup.commentIds === true) {
            const submit = shadow.submitReview.bind(shadow);
            shadow.submitReview = async (...args) => {
              const review = await submit(...args);
              return { ...review, commentIds: review.payload.comments.map(() => nextComment++) };
            };
          }
          // As if the reviews were on GitHub, for the tests that put them there.
          shadow.markersAt = async (_pull, commitId) => [...(reviewsOnGitHub.get(commitId) ?? [])];
          shadow.checkRunsOn = async () =>
            [...checkRunsOnGitHub].map((externalId) => ({
              externalId,
              annotations: checkRunAnnotations.get(externalId) ?? 0,
            }));
          const labels = shadow.labels.bind(shadow);
          shadow.labels = (ref) => {
            const client = labels(ref);
            return Object.assign(Object.create(client) as typeof client, {
              removePrLabel: async (label: string) => {
                removedLabels.push(label);
              },
            });
          };
          const completeCheckRun = shadow.completeCheckRun.bind(shadow);
          shadow.completeCheckRun = async (ref, input) => {
            const done = await completeCheckRun(ref, input);
            if (input.externalId !== undefined) {
              checkRunsOnGitHub.add(input.externalId);
              checkRunAnnotations.set(input.externalId, input.annotations.length);
            }
            return done;
          };
          return shadow;
        },
      };
    },
    async clone(options) {
      clones.count += 1;
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
    execution,
    heartbeats,
    reviewsOnGitHub,
    checkRunsOnGitHub,
    checkRunAnnotations,
    fileReads,
    clones,
    removedLabels,
    /**
     * Puts a review of ours with this marker on the commit, and, `finished`, its run's check
     * run too: that run finished the head.
     */
    addReview: (commitId: string, marker: string, state = "COMMENTED", finished = true) => {
      reviewsOnGitHub.set(commitId, [...(reviewsOnGitHub.get(commitId) ?? []), { marker, state }]);
      if (finished) checkRunsOnGitHub.add(markerRun(marker));
    },
    tasks,
  };
}

const JOB = { installationId: 99, repo: "acme/shop", prNumber: 7 };

function output(overrides: Partial<BatchOutput> = {}): BatchOutput {
  return { version: 1, index: 0, findings: [finding()], transcriptKeys: [], ...overrides };
}

/** The run marker at the end of a review body. */
function markerIn(body: string): string {
  return /<!-- (lgtmoose-run:[^ ]+) -->/.exec(body)?.[1] ?? "";
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

  describe("review triggers (NIC-1077)", () => {
    const LABEL_CONFIG = "review:\n  trigger: label\n";
    const push = { ...JOB, kind: "pr_updated" as const, actor: "dev" };

    it("waits for the label without cloning, and says so in a blocking check run", async () => {
      const h = harness({ config: LABEL_CONFIG, labels: ["bug"] });
      const result = await prepare(h.deps, push, EXECUTION, SETTINGS);

      expect(result).toEqual({ runId: RUN_ID, superseded: true, batches: [] });
      expect(h.runs.runs.get(RUN_ID)?.status).toBe("superseded");
      expect(h.clones.count).toBe(0);
      // The config is read at the base: the PR can't change its own trigger.
      expect(h.fileReads).toEqual([`${baseSha}:.lgtmoose.yaml`]);
      const [check] = shadowRecords(h.objects, "check-run");
      expect(check).toMatchObject({
        head_sha: headSha,
        conclusion: "action_required",
        title: "Waiting for a trigger",
      });
      expect(String(check?.summary)).toContain("lgtmoose\\:review label");
      expect(h.checkRunsOnGitHub.has(RUN_ID)).toBe(true);
      // Nothing else: no batches, no manifest, no summary.
      expect(h.objects.has(runKeys(RUN_ID).prepared)).toBe(false);
      expect(shadowRecords(h.objects, "summary")).toEqual([]);
    });

    it("reserves no spend for a run it skips (NIC-1079)", async () => {
      const h = harness({ config: LABEL_CONFIG, labels: ["bug"] });
      const spend = memorySpend();
      h.deps.spend = { store: spend.store, budgets: budgetsSchema.parse({ monthlyUsd: 10 }) };
      expect(await prepare(h.deps, push, EXECUTION, SETTINGS)).toMatchObject({ superseded: true });
      expect(spend.reserved.size).toBe(0);
      expect(spend.capped.size).toBe(0);
    });

    it("reviews once the PR carries the label, taking it off with label_once", async () => {
      const h = harness({
        config: `${LABEL_CONFIG}  label_once: true\n`,
        labels: ["lgtmoose:review"],
      });
      const result = await prepare(
        h.deps,
        { ...push, kind: "pr_labeled", label: "lgtmoose:review" },
        EXECUTION,
        SETTINGS,
      );
      expect(result).toMatchObject({ superseded: false, batches: [{ index: 0 }] });
      expect(h.clones.count).toBe(1);
      expect(h.removedLabels).toEqual(["lgtmoose:review"]);
    });

    it("posts nothing for a label that isn't the trigger, or an untrusted bot's", async () => {
      for (const job of [
        { ...push, kind: "pr_labeled" as const, label: "bug" },
        {
          ...push,
          kind: "pr_labeled" as const,
          label: "lgtmoose:review",
          actor: "renovate[bot]",
          botActor: true as const,
        },
      ]) {
        const h = harness({ config: LABEL_CONFIG, labels: ["lgtmoose:review", "bug"] });
        expect(await prepare(h.deps, job, EXECUTION, SETTINGS)).toMatchObject({
          superseded: true,
        });
        expect(h.clones.count).toBe(0);
        expect([...h.objects.keys()]).toEqual([]);
      }
    });

    it("reviews a command's run whatever the trigger", async () => {
      const h = harness({ config: "review:\n  trigger: command\n" });
      const result = await prepare(h.deps, { ...push, requested: "review" }, EXECUTION, SETTINGS);
      expect(result).toMatchObject({ superseded: false });
    });

    it("pauses a push after its automatic reviews, and a requested review starts the count over", async () => {
      const config = "review:\n  auto_pause_after: 2\n";
      const paused = harness({ config });
      paused.runs.pause.reviews = 2;
      expect(await prepare(paused.deps, push, EXECUTION, SETTINGS)).toMatchObject({
        superseded: true,
      });
      expect(paused.logs).toContain("not triggered");
      const [check] = shadowRecords(paused.objects, "check-run");
      expect(String(check?.summary)).toContain("paused after 2");
      expect(String(check?.summary)).toContain("`resume`");

      const asked = harness({ config });
      asked.runs.pause.reviews = 2;
      expect(
        await prepare(asked.deps, { ...push, requested: "review" }, EXECUTION, SETTINGS),
      ).toMatchObject({ superseded: false });
      expect(asked.runs.pause.arms).toEqual([headSha]);
      expect(asked.runs.pause.reviews).toBe(0);
      expect(asked.runs.pause.noted).toEqual([RUN_ID]);
      expect(asked.runs.pause.head).toBeUndefined();
    });

    it("leaves the run CI releases out of the count, and not a push of the same commit", async () => {
      const config = "review:\n  auto_pause_after: 2\n";
      const released = harness({ config });
      released.runs.pause.head = headSha;
      released.runs.pause.reviews = 1;
      expect(
        await prepare(released.deps, { ...push, kind: "pr_checks" }, EXECUTION, SETTINGS),
      ).toMatchObject({ superseded: false });
      expect(released.runs.pause.noted).toEqual([RUN_ID]);
      expect(released.runs.pause.head).toBeUndefined();
      expect(released.runs.pause.reviews).toBe(1);

      const sameCommit = harness({ config });
      sameCommit.runs.pause.head = headSha;
      sameCommit.runs.pause.reviews = 1;
      expect(await prepare(sameCommit.deps, push, EXECUTION, SETTINGS)).toMatchObject({
        superseded: false,
      });
      expect(sameCommit.runs.pause.noted).toEqual([]);
      expect(sameCommit.runs.pause.head).toBe(headSha);
    });

    it("posts no check run while waiting with gate.check_run: off", async () => {
      const h = harness({ config: "review:\n  trigger: command\ngate:\n  check_run: off\n" });
      expect(await prepare(h.deps, push, EXECUTION, SETTINGS)).toMatchObject({ superseded: true });
      expect([...h.objects.keys()]).toEqual([]);
    });
  });
});

describe("waiting for CI (NIC-1078)", () => {
  const push = { ...JOB, kind: "pr_updated" as const, actor: "dev" };
  const CONFIG = "review:\n  wait_for_checks: [build, test]\n  wait_timeout_minutes: 30\n";
  const run = (name: string, status: string, conclusion?: string) => ({
    name,
    status,
    conclusion,
  });
  const passed: HeadChecks = {
    runs: [run("build", "completed", "success"), run("test", "completed", "skipped")],
    statuses: [],
  };
  const running: HeadChecks = {
    runs: [run("build", "completed", "success"), run("test", "in_progress")],
    statuses: [],
  };

  function waiting(setup: Setup, waits = memoryChecksWaits()) {
    const h = harness({ config: CONFIG, ...setup });
    h.deps.checksWaits = waits.store;
    return { h, waits };
  }

  it("waits for a running check without cloning, and says which in a blocking check run", async () => {
    const { h, waits } = waiting({ checks: () => running });
    expect(await prepare(h.deps, push, EXECUTION, SETTINGS)).toEqual({
      runId: RUN_ID,
      superseded: true,
      batches: [],
    });
    expect(h.clones.count).toBe(0);
    expect(waits.row).toMatchObject({ headSha, state: "pending" });
    const [check] = shadowRecords(h.objects, "check-run");
    expect(check).toMatchObject({
      head_sha: headSha,
      conclusion: "action_required",
      title: "Waiting for CI",
    });
    expect(String(check?.summary)).toContain("test");
    expect(String(check?.summary)).not.toContain("build");
    expect(String(check?.summary)).toContain("30 minutes");
  });

  it("posts nothing new while the checks say the same, so its own check run doesn't loop", async () => {
    const waits = memoryChecksWaits();
    waits.row = { headSha, since: new Date(), state: "pending" };
    const { h } = waiting({ checks: () => running }, waits);
    const checksJob = { ...push, kind: "pr_checks" as const };
    expect(await prepare(h.deps, checksJob, EXECUTION, SETTINGS)).toMatchObject({
      superseded: true,
    });
    expect(shadowRecords(h.objects, "check-run")).toEqual([]);
  });

  it("holds on a failed check whatever the timeout, naming it", async () => {
    const waits = memoryChecksWaits();
    waits.row = { headSha, since: new Date(Date.now() - 3 * 3600_000), state: "pending" };
    const failed: HeadChecks = {
      runs: [run("build", "completed", "failure")],
      statuses: [{ context: "test", state: "success" }],
    };
    const { h } = waiting({ checks: () => failed }, waits);
    expect(
      await prepare(h.deps, { ...push, kind: "pr_checks" }, EXECUTION, SETTINGS),
    ).toMatchObject({ superseded: true });
    expect(h.clones.count).toBe(0);
    expect(waits.row?.state).toBe("failed:build");
    const [check] = shadowRecords(h.objects, "check-run");
    expect(check).toMatchObject({ title: "Waiting for CI to pass" });
    expect(String(check?.summary)).toContain("build failed");
  });

  it("reviews once the checks pass, and clears the wait", async () => {
    const waits = memoryChecksWaits();
    waits.row = { headSha, since: new Date(), state: "pending" };
    const { h } = waiting({ checks: () => passed }, waits);
    expect(
      await prepare(h.deps, { ...push, kind: "pr_checks" }, EXECUTION, SETTINGS),
    ).toMatchObject({ superseded: false, batches: [{ index: 0 }] });
    expect(waits.row).toBeUndefined();
    const manifest = JSON.parse(h.objects.get(runKeys(RUN_ID).prepared) ?? "") as RunManifest;
    expect(manifest.notices).toBeUndefined();
  });

  it("reviews after the timeout, and its summary says it didn't wait", async () => {
    const waits = memoryChecksWaits();
    waits.row = { headSha, since: new Date(Date.now() - 31 * 60_000), state: "pending" };
    const { h } = waiting({ checks: () => running }, waits);
    expect(
      await prepare(h.deps, { ...push, kind: "pr_checks" }, EXECUTION, SETTINGS),
    ).toMatchObject({ superseded: false });
    const manifest = JSON.parse(h.objects.get(runKeys(RUN_ID).prepared) ?? "") as RunManifest;
    expect(manifest.notices).toEqual([
      "This review didn't wait for CI: after 30 minutes, test still hadn't finished.",
    ]);
  });

  it("starts the wait again for a new head", async () => {
    const waits = memoryChecksWaits();
    const old = new Date(Date.now() - 3600_000);
    waits.row = { headSha: baseSha, since: old, state: "pending" };
    const { h } = waiting({ checks: () => running }, waits);
    await prepare(h.deps, push, EXECUTION, SETTINGS);
    expect(waits.row?.headSha).toBe(headSha);
    expect(waits.row?.since.getTime()).toBeGreaterThan(old.getTime());
  });

  it("leaves out the review CI starts for a head someone asked to review", async () => {
    const checks = { current: running };
    const { h } = waiting({
      checks: () => checks.current,
      config: `${CONFIG}  auto_pause_after: 2\n`,
    });
    expect(
      await prepare(h.deps, { ...push, requested: "review", actor: "dev" }, EXECUTION, SETTINGS),
    ).toMatchObject({ superseded: true });
    expect(h.runs.pause.head).toBe(headSha);
    expect(h.runs.pause.resets).toBe(0);

    checks.current = passed;
    expect(
      await prepare(h.deps, { ...push, kind: "pr_checks" }, `${EXECUTION}:ci`, SETTINGS),
    ).toMatchObject({ superseded: false });
    expect(h.runs.pause.resets).toBe(0);
    expect(h.runs.pause.noted).toEqual(["0b6f6d8e-3c1a-4c3e-9a51-000000000001"]);
    expect(h.runs.pause.head).toBeUndefined();
  });

  it("lets a review command from someone with write access skip the wait, not the author's", async () => {
    const { h: lead, waits } = waiting({ checks: () => running });
    waits.row = { headSha, since: new Date(), state: "pending" };
    expect(
      await prepare(
        lead.deps,
        { ...push, requested: "review", actor: "lead" },
        EXECUTION,
        SETTINGS,
      ),
    ).toMatchObject({ superseded: false });
    expect(waits.row).toBeUndefined();

    const { h: author } = waiting({ checks: () => running });
    expect(
      await prepare(
        author.deps,
        { ...push, requested: "review", actor: "dev" },
        EXECUTION,
        SETTINGS,
      ),
    ).toMatchObject({ superseded: true });
    expect(author.clones.count).toBe(0);
  });

  it("waits for the base branch's required checks, never its own", async () => {
    const { h, waits } = waiting({
      config: "review:\n  wait_for_checks: required\n",
      required: ["ci", "LGTMoose"],
      checks: () => ({
        runs: [run("LGTMoose", "completed", "action_required")],
        statuses: [{ context: "ci", state: "pending" }],
      }),
    });
    expect(await prepare(h.deps, push, EXECUTION, SETTINGS)).toMatchObject({ superseded: true });
    const [check] = shadowRecords(h.objects, "check-run");
    expect(String(check?.summary)).toContain("ci");
    expect(String(check?.summary)).not.toContain("LGTMoose\\,");
    expect(waits.row?.state).toBe("pending");
  });

  it("doesn't wait when the branch requires no checks, or with the default off", async () => {
    for (const config of ["review:\n  wait_for_checks: required\n", ""]) {
      const { h, waits } = waiting({ config, required: [], checks: () => running });
      expect(await prepare(h.deps, push, EXECUTION, SETTINGS)).toMatchObject({
        superseded: false,
      });
      expect(waits.row).toBeUndefined();
    }
  });

  it("judges replies only while the code waits for CI", async () => {
    const { h } = waiting({ checks: () => running });
    const result = await prepare(h.deps, { ...push, requested: "replies" }, EXECUTION, SETTINGS);
    expect(result.superseded).toBe(false);
    const manifest = JSON.parse(h.objects.get(runKeys(RUN_ID).prepared) ?? "") as RunManifest;
    expect(manifest.conversationOnly).toBe(true);
    expect(manifest.review.jobs).toEqual([]);
  });

  it("starts nothing for a check on a draft PR", async () => {
    const { h, waits } = waiting({ checks: () => passed });
    waits.row = { headSha, since: new Date(), state: "pending" };
    const reader = (await h.deps.github(99)).reader;
    const original = reader.pull.bind(reader);
    reader.pull = async (target) => ({ ...(await original(target)), draft: true });
    expect(
      await prepare(h.deps, { ...push, kind: "pr_checks" }, EXECUTION, SETTINGS),
    ).toMatchObject({ superseded: true });
    expect(h.clones.count).toBe(0);
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
  const TASK_C = "arn:aws:ecs:eu-west-1:123456789012:task/lgtmoose/ccc";
  const as = (taskArn: string, id = taskArn): { attempt: PostAttempt } => ({
    attempt: { id, taskArn },
  });
  async function ready(setup: Setup = {}) {
    const h = harness(setup);
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
    h.addReview(headSha, reviewMarker(RUN_ID, true));
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

  it("records a review a dead holder posted, even after the head has moved on", async () => {
    const setup: Setup = {};
    const h = harness(setup);
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h);
    const claim = runKeys(RUN_ID).reviewClaim;
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "old", taskArn: TASK_A }));
    h.tasks.set(TASK_A, "STOPPED");
    // It posted the review and died before saving; a push has come in since.
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    setup.head = "f".repeat(40);
    const taskStatus = (arn: string) => h.deps.taskStatus(arn);
    expect(await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(calls).not.toContain("submitReview");
    expect(h.runs.runs.get(RUN_ID)).toMatchObject({ status: "succeeded" });
  });

  /** A second run of the same PR at the same head, ready to post. */
  function secondRun(h: ReturnType<typeof harness>, runId: string) {
    const first = h.runs.runs.get(RUN_ID);
    if (first === undefined) throw new Error("prepare first");
    h.runs.runs.set(runId, { ...first, runId, status: "running" });
    h.objects.set(runKeys(runId).prepared, h.objects.get(runKeys(RUN_ID).prepared) ?? "");
    h.objects.set(runKeys(runId).batchOutput(0), JSON.stringify(output()));
  }
  const RUN_2 = "0b6f6d8e-3c1a-4c3e-9a51-6f1f0e0c2a22";
  const RUN_3 = "0b6f6d8e-3c1a-4c3e-9a51-6f1f0e0c2a33";
  /** The covering run's saved progress once it has written its check run and summary. */
  const theirOutputs = {
    attempt: "x",
    writes: 3,
    review: true,
    checkRun: true,
    summary: true,
    summaryBody: "their summary",
    label: true,
  };

  it("posts nothing of its own when the covering run wrote the head's outputs", async () => {
    // A stopped run's post finished after the PR was reopened; the reopen's retry is a new run.
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    // The covering run wrote its outputs and recorded the PR at this head.
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ ...theirOutputs, labelTarget: "Approved" }),
    );
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: false,
      coveredBy: reviewMarker(RUN_ID, true),
    });
    // No review or check run, and no summary or label from a decision that was never posted:
    // their summary and label, put back on the PR (idempotent when they're there already).
    expect(calls).toEqual(["upsertSummaryComment", "labels"]);
    const [summary] = shadowRecords(h.objects, "summary-comment");
    expect(summary).toMatchObject({ body: "their summary" });
    // Succeeded, without touching the PR's record (that's the posting run's).
    expect(h.runs.runs.get(RUN_2)).toMatchObject({ status: "covered", covered: true });
    expect(h.runs.runs.get(RUN_2)).not.toHaveProperty("result");
    // A retry of it carries on covered, writing nothing more.
    calls.length = 0;
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      coveredBy: reviewMarker(RUN_ID, true),
    });
    expect(calls).toEqual([]);
  });

  it("lets a retry post when an attempt timed out without posting", async () => {
    const { h, taskStatus } = await ready();
    const calls = countingPoster(h, { what: "submitReview", times: 1 });
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow("GitHub 502");
    h.tasks.set(TASK_A, "STOPPED");
    // Nothing reached GitHub, so the head has no review of ours: the retry posts it.
    expect(await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toHaveLength(2);
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("succeeded");
  });

  it("posts a complete review over an incomplete COMMENT one", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // An earlier run's batches failed: its review is incomplete.
    h.addReview(headSha, reviewMarker(RUN_ID, false), "COMMENTED");
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
      complete: true,
    });
    expect(reviews(calls)).toHaveLength(1);
    const [review] = shadowRecords(h.objects, "review");
    expect(JSON.stringify(review)).toContain(`<!-- ${reviewMarker(RUN_2, true)} -->`);
  });

  it("doesn't approve past an incomplete run's blocking finding", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    const prepared = h.objects.get(runKeys(RUN_ID).prepared) ?? "";
    // The first run is incomplete (a second batch never wrote its output) and posts a blocking
    // finding.
    const manifest = JSON.parse(prepared) as RunManifest;
    manifest.review.jobs.push({ index: 1, files: ["src/total.ts"], prompt: "never run" });
    h.objects.set(runKeys(RUN_ID).prepared, JSON.stringify(manifest));
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const first = await post(h.deps, RUN_ID, as(TASK_A));
    expect(first).toMatchObject({ posted: true, complete: false, event: "REQUEST_CHANGES" });
    expect(h.findings.rows).toMatchObject([{ status: "open", severity: "blocking" }]);
    h.addReview(headSha, reviewMarker(RUN_ID, false), "CHANGES_REQUESTED");

    // A complete run at the same head finds nothing new: it posts its own review, and the
    // incomplete run's finding still holds the decision.
    secondRun(h, RUN_2);
    h.objects.set(runKeys(RUN_2).prepared, prepared);
    h.objects.set(runKeys(RUN_2).batchOutput(0), JSON.stringify(output({ findings: [] })));
    const second = await post(h.deps, RUN_2, as(TASK_B));
    expect(second).toMatchObject({ posted: true, complete: true, event: "REQUEST_CHANGES" });
    expect(second.coveredBy).toBeUndefined();
  });

  it("lists the reviews that could cover a run by their completeness and state", () => {
    const review = (complete: boolean, state = "COMMENTED", run = RUN_ID) => ({
      marker: reviewMarker(run, complete),
      state,
    });
    expect(coveringReviews([], true)).toEqual([]);
    expect(coveringReviews([review(true)], true)).toEqual([review(true)]);
    expect(coveringReviews([review(true)], false)).toEqual([review(true)]);
    expect(coveringReviews([review(false)], true)).toEqual([]);
    expect(coveringReviews([review(false)], false)).toEqual([review(false)]);
    // Whatever it decided: its findings count in the complete run's decision.
    expect(coveringReviews([review(false, "CHANGES_REQUESTED")], true)).toEqual([]);
    // The complete ones first.
    expect(coveringReviews([review(false), review(true, "COMMENTED", RUN_2)], false)).toEqual([
      review(true, "COMMENTED", RUN_2),
      review(false),
    ]);
  });

  it("takes turns with another run at the same head, through the head's claim", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // Another run at this head holds the head's claim, its task still running.
    const pullKey = headKeys("acme/shop", 7, headSha).reviewClaim;
    await h.deps.store.createText(pullKey, JSON.stringify({ attempt: "other", taskArn: TASK_A }));
    h.tasks.set(TASK_A, "RUNNING");
    await expect(post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).rejects.toThrow(
      "this head's post",
    );
    expect(reviews(calls)).toEqual([]);
    // It posted and stopped: this run finds its review and posts none.
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    h.tasks.set(TASK_A, "STOPPED");
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      coveredBy: reviewMarker(RUN_ID, true),
    });
    expect(reviews(calls)).toEqual([]);
    // And this run lets go of the head's claim once it's done there.
    expect(h.objects.has(pullKey)).toBe(false);
  });

  it("posts a second review when the run whose review is on the head never finished it", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // The first run's review goes up, then its check run fails; the second run comes along.
    const github = h.deps.github.bind(h.deps);
    let checkRuns = 0;
    const checkIds: (string | undefined)[] = [];
    h.deps.github = async (id) => {
      const real = await github(id);
      return {
        ...real,
        poster: (runId, pull) => {
          const poster = real.poster(runId, pull);
          return {
            ...poster,
            labels: poster.labels.bind(poster),
            startCheckRun: poster.startCheckRun.bind(poster),
            upsertSummaryComment: poster.upsertSummaryComment.bind(poster),
            markersAt: poster.markersAt.bind(poster),
            submitReview: async (ref, commitId, payload) => {
              h.addReview(commitId, markerIn(payload.body), "CHANGES_REQUESTED", false);
              return poster.submitReview(ref, commitId, payload);
            },
            completeCheckRun: async (ref, input) => {
              checkRuns += 1;
              checkIds.push(input.externalId);
              if (checkRuns === 1) throw new Error("GitHub 502");
              return poster.completeCheckRun(ref, input);
            },
          };
        },
      };
    };
    const first = post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus });
    await expect(first).rejects.toThrow("GitHub 502");
    // The first run's check run never got in, so its review doesn't cover the second run,
    // which posts one of its own, and its own check run, summary and label.
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(h.reviewsOnGitHub.get(headSha)?.map((review) => review.marker)).toEqual([
      reviewMarker(RUN_ID, true),
      reviewMarker(RUN_2, true),
    ]);
    expect(checkIds).toEqual([RUN_ID, RUN_2]);
    expect(reviews(calls)).toHaveLength(2);
    expect(h.runs.runs.get(RUN_2)?.status).toBe("succeeded");
  });

  it("takes over an off-ECS claim, of either kind, once it has expired", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    const old = Date.now() - OFF_ECS_CLAIM_TTL_MS - 1;
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "laptop", claimedAt: old }));
    const headClaim = headKeys("acme/shop", 7, headSha).reviewClaim;
    await h.deps.store.createText(headClaim, JSON.stringify({ attempt: "laptop", claimedAt: old }));
    expect(await post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toHaveLength(1);
    expect(JSON.parse(h.objects.get(claim) ?? "{}")).toMatchObject({ taskArn: TASK_A });
  });

  it("records a covered run as covered even when that fails the first time", async () => {
    const { h, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    const coverRun = h.runs.coverRun.bind(h.runs);
    let tries = 0;
    h.runs.coverRun = async (runId, result) => {
      tries += 1;
      if (tries === 1) throw new Error("database blip");
      return coverRun(runId, result);
    };
    await expect(post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).rejects.toThrow("blip");
    // Never recorded as posted over the PR's record.
    expect(h.runs.runs.get(RUN_2)).toMatchObject({ status: "covered" });
    expect(h.runs.runs.get(RUN_2)).not.toHaveProperty("result");
  });

  it("takes its own run's review, found under the head's claim, as its own", async () => {
    const { h, calls, taskStatus } = await ready();
    // An earlier attempt of this run posted and died before saving; no takeover is involved
    // (its claim was released), so it's the head's check that finds it.
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    expect(await post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toEqual([]);
    expect(calls).toContain("completeCheckRun");
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("succeeded");
  });

  it("holds the head's claim for its whole post, so another run at the head waits", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // The first run's review goes up, then its check run fails: it keeps the head's claim
    // (its task still running) until its retry finishes or it stops.
    const github = h.deps.github.bind(h.deps);
    let failCheck = true;
    h.deps.github = async (id) => {
      const real = await github(id);
      return {
        ...real,
        poster: (runId, pull) => {
          const poster = real.poster(runId, pull);
          return {
            ...poster,
            labels: poster.labels.bind(poster),
            startCheckRun: poster.startCheckRun.bind(poster),
            upsertSummaryComment: poster.upsertSummaryComment.bind(poster),
            markersAt: poster.markersAt.bind(poster),
            submitReview: async (ref, commitId, payload) => {
              h.addReview(commitId, markerIn(payload.body), "COMMENTED", false);
              return poster.submitReview(ref, commitId, payload);
            },
            completeCheckRun: async (ref, input) => {
              if (failCheck) throw new Error("GitHub 502");
              return poster.completeCheckRun(ref, input);
            },
          };
        },
      };
    };
    h.tasks.set(TASK_A, "RUNNING");
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow("GitHub 502");
    // The second run can't start writing at this head between the first run's writes.
    await expect(post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).rejects.toThrow(
      "this head's post",
    );
    expect(calls.filter((call) => call !== "submitReview")).toEqual([]);
    // The first run's retry finishes, and lets the head go.
    failCheck = false;
    h.tasks.set(TASK_A, "STOPPED");
    expect(await post(h.deps, RUN_ID, as(TASK_C))).toMatchObject({ posted: true });
    expect(h.objects.has(headKeys("acme/shop", 7, headSha).reviewClaim)).toBe(false);
  });

  it("brings the PR up to the covering run's summary and label when it's at this head", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    // The covering run wrote its summary and label, but deferred its record to this run,
    // whose event is later (a reopen).
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ ...theirOutputs, labelTarget: "Approved" }),
    );
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      coveredBy: reviewMarker(RUN_ID, true),
    });
    expect(calls).toEqual(["upsertSummaryComment", "labels"]);
    const [summary] = shadowRecords(h.objects, "summary-comment");
    expect(summary).toMatchObject({ body: "their summary" });
    expect(h.runs.runs.get(RUN_2)?.status).toBe("covered");
    expect(h.runs.runs.get(RUN_2)?.coverResult).toMatchObject({
      pr: { headSha, statusLabel: "Approved" },
    });
  });

  it("posts its own review when the covering run never finished the head", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // The other run posted its review and died: no check run, and its retries are spent.
    h.addReview(headSha, reviewMarker(RUN_ID, true), "CHANGES_REQUESTED", false);
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ attempt: "x", writes: 1, review: true }),
    );
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(calls).toEqual(["submitReview", "completeCheckRun", "upsertSummaryComment", "labels"]);
    expect(h.runs.runs.get(RUN_2)?.status).toBe("succeeded");
  });

  it("is covered by a run that finished the head, past one that didn't", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    secondRun(h, RUN_3);
    // RUN_ID's run died after its review; RUN_2 posted another and finished.
    h.addReview(headSha, reviewMarker(RUN_ID, true), "COMMENTED", false);
    h.addReview(headSha, reviewMarker(RUN_2, true));
    expect(await post(h.deps, RUN_3, { ...as(TASK_B), taskStatus })).toMatchObject({
      coveredBy: reviewMarker(RUN_2, true),
    });
    expect(reviews(calls)).toEqual([]);
  });

  it("goes by the covering run's readable progress over a check run on GitHub", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // Its check run is on GitHub, but its progress says it didn't finish it (it died mid-way
    // through the annotation pages, say): not finished.
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ attempt: "x", writes: 1, review: true }),
    );
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toHaveLength(1);
  });

  it("takes a check run sent in full, though never saved as done, as finishing the head", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // The covering run saved how many annotations its check run was to have, sent them all,
    // and died before saving that it was done.
    h.addReview(headSha, reviewMarker(RUN_ID, true), "COMMENTED", false);
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ attempt: "x", writes: 2, review: true, checkRunAnnotations: 2 }),
    );
    h.checkRunsOnGitHub.add(RUN_ID);
    h.checkRunAnnotations.set(RUN_ID, 2);
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      coveredBy: reviewMarker(RUN_ID, true),
    });
    expect(reviews(calls)).toEqual([]);
  });

  it("doesn't take a check run with annotations still to come as finishing the head", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true), "COMMENTED", false);
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ attempt: "x", writes: 2, review: true, checkRunAnnotations: 120 }),
    );
    h.checkRunsOnGitHub.add(RUN_ID);
    h.checkRunAnnotations.set(RUN_ID, 50);
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toHaveLength(1);
  });

  it("finds the covering run's check run on GitHub when its progress is gone", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    // No posted.json (it expires): the check run under that run's external ID says it finished.
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    expect(await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).toMatchObject({
      coveredBy: reviewMarker(RUN_ID, true),
    });
    // Covered, with nothing to bring the PR up to: no summary or label of theirs to copy.
    expect(calls).toEqual([]);
    expect(h.runs.runs.get(RUN_2)?.coverResult).not.toHaveProperty("pr");
    // Unreadable progress goes the same way.
    secondRun(h, RUN_3);
    await h.deps.store.createText(runKeys(RUN_ID).posted, "not json");
    expect(await post(h.deps, RUN_3, { ...as(TASK_C), taskStatus })).toMatchObject({
      coveredBy: reviewMarker(RUN_ID, true),
    });
    expect(calls).toEqual([]);
  });

  it("records a covered run on the PR once it has written the PR's summary, even failing", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ ...theirOutputs, labelTarget: "Approved" }),
    );
    // The database blips before the label: the summary is written, the label isn't.
    const newer = h.runs.newerRunPosted.bind(h.runs);
    let looks = 0;
    h.runs.newerRunPosted = async (run) => {
      looks += 1;
      if (looks === 3) throw new Error("database blip");
      return newer(run);
    };
    await expect(post(h.deps, RUN_2, { ...as(TASK_B), taskStatus })).rejects.toThrow("blip");
    expect(calls).toEqual(["upsertSummaryComment"]);
    // Recorded with the label it set out to write, never none.
    expect(h.runs.runs.get(RUN_2)?.coverResult).toMatchObject({
      pr: { headSha, statusLabel: "Approved" },
    });
    // Its retry, with the covering run's progress gone meanwhile, still owes the label and
    // writes it.
    h.objects.delete(runKeys(RUN_ID).posted);
    h.tasks.set(TASK_B, "STOPPED");
    await post(h.deps, RUN_2, { ...as(TASK_C), taskStatus });
    expect(calls).toEqual(["upsertSummaryComment", "labels"]);
    expect(h.runs.runs.get(RUN_2)?.coverResult).toMatchObject({
      pr: { headSha, statusLabel: "Approved" },
    });
  });

  it("leaves the PR to a covering run that may still be retried", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    // It wrote its check run and summary, but not yet its label, and its execution runs on:
    // its retry writes that, and would leave it to this newer run if this run wrote anything.
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ ...theirOutputs, label: false, decisionLabel: "Requires Changes" }),
    );
    const executionStatus = async () => "RUNNING";
    await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus, executionStatus });
    expect(calls).toEqual([]);
    expect(h.runs.runs.get(RUN_2)?.coverResult).not.toHaveProperty("pr");
  });

  it("sets the label the covering run's decision called for when it never set it", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ ...theirOutputs, label: false, decisionLabel: "Requires Changes" }),
    );
    await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus });
    expect(calls).toEqual(["upsertSummaryComment", "labels"]);
    expect(h.runs.runs.get(RUN_2)?.coverResult).toMatchObject({
      pr: { headSha, statusLabel: "Requires Changes" },
    });
  });

  it("sets no label of its own when the covering run's decision set none", async () => {
    const { h, calls, taskStatus } = await ready();
    secondRun(h, RUN_2);
    h.addReview(headSha, reviewMarker(RUN_ID, true));
    await h.deps.store.createText(
      runKeys(RUN_ID).posted,
      JSON.stringify({ ...theirOutputs, label: false }),
    );
    await post(h.deps, RUN_2, { ...as(TASK_B), taskStatus });
    // Their summary only: this run's own decision was never posted.
    expect(calls).toEqual(["upsertSummaryComment"]);
    const result = h.runs.runs.get(RUN_2)?.coverResult;
    expect(result).toMatchObject({ pr: { headSha } });
    // Recorded without a label, which leaves the PR's recorded one as it is.
    expect(result?.pr?.statusLabel).toBeUndefined();
  });

  it("lets another run's off-ECS head claim expire before taking it over", async () => {
    const { h, calls } = await ready();
    const headClaim = headKeys("acme/shop", 7, headSha).reviewClaim;
    const laptop = { attempt: { id: "mine", taskArn: undefined } };
    // Fresh, from another run: even an off-ECS attempt waits.
    await h.deps.store.createText(
      headClaim,
      JSON.stringify({ attempt: "other", runId: RUN_2, claimedAt: Date.now() }),
    );
    await expect(post(h.deps, RUN_ID, laptop)).rejects.toThrow("off ECS");
    expect(reviews(calls)).toEqual([]);
    // Expired: taken over.
    const stale = Date.now() - OFF_ECS_CLAIM_TTL_MS - 1;
    const read = await h.deps.store.getTagged(headClaim);
    await h.deps.store.replaceText(
      headClaim,
      JSON.stringify({ attempt: "other", runId: RUN_2, claimedAt: stale }),
      read?.etag ?? "",
    );
    expect(
      await post(h.deps, RUN_ID, { attempt: { id: "mine-2", taskArn: undefined } }),
    ).toMatchObject({
      posted: true,
    });
    expect(reviews(calls)).toHaveLength(1);
  });

  it("treats an off-ECS claim without a time as fresh", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    await h.deps.store.createText(claim, JSON.stringify({ attempt: "laptop", runId: RUN_ID }));
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow("off ECS");
    expect(calls).toEqual([]);
  });

  it("leaves an off-ECS holder's claim alone when on ECS", async () => {
    const { h, calls, claim, taskStatus } = await ready();
    await h.deps.store.createText(
      claim,
      JSON.stringify({ attempt: "laptop", claimedAt: Date.now() }),
    );
    await expect(post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus })).rejects.toThrow("off ECS");
    expect(calls).toEqual([]);
  });

  it("looks the head's reviews up once per post, takeover or not", async () => {
    const { h, claim, taskStatus } = await ready();
    let lookups = 0;
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (id) => {
      const real = await github(id);
      return {
        ...real,
        poster: (runId, pull) => {
          const poster = real.poster(runId, pull);
          const markersAt = poster.markersAt.bind(poster);
          poster.markersAt = async (ref, commitId, prefix) => {
            lookups += 1;
            expect(prefix).toBe("lgtmoose-run:");
            return markersAt(ref, commitId, prefix);
          };
          return poster;
        },
      };
    };
    await post(h.deps, RUN_ID, { ...as(TASK_A), taskStatus });
    expect(lookups).toBe(1);
    // A takeover reuses the one listing, for its own review and for whether it's covered.
    h.objects.delete(runKeys(RUN_ID).posted);
    h.tasks.set(TASK_A, "STOPPED");
    await post(h.deps, RUN_ID, { ...as(TASK_B), taskStatus });
    expect(lookups).toBe(2);
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
    expect(h.logs).toContain("releasing a claim failed");
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
    expect(JSON.stringify(review)).toContain(`<!-- ${reviewMarker(RUN_ID, true)} -->`);
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
    // Its first save (its decision's label, before the review) fails: nothing is posted.
    expect(calls).toEqual([]);
  });

  it("saves progress that names its attempt and counts its writes", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    await post(h.deps, RUN_ID, as(TASK_A, "attempt-1"));
    expect(JSON.parse(h.objects.get(runKeys(RUN_ID).posted) ?? "{}")).toMatchObject({
      attempt: "attempt-1",
      // The decision's label, the review, its findings, the check run, the summary, the label.
      writes: 6,
      findings: true,
      decisionLabel: expect.any(String),
      checkRunAnnotations: expect.any(Number),
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

  it("leaves the summary and label to a run for a later event that already posted", async () => {
    const h = harness();
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    h.objects.set(runKeys(RUN_ID).batchOutput(0), JSON.stringify(output()));
    const calls = countingPoster(h);
    h.runs.newer.posted = true;
    expect(await post(h.deps, RUN_ID)).toMatchObject({ posted: true });
    // The check run is the head's: this run holds the head, so it's written.
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
      result: { filesDone: 1, headSha, review: { event: "REQUEST_CHANGES" } },
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
    // Both runs record what they decided (NIC-1145), the quiet one too, though it posted no
    // review: the first with its review, the second with none.
    const results = [...h.runs.runs.values()].map((run) => run.result);
    expect(results).toEqual([
      expect.objectContaining({
        review: expect.objectContaining({ event: "REQUEST_CHANGES" }),
        decision: { outcome: "request_changes", counts: { blocking: 1, should_fix: 0, nit: 0 } },
      }),
      expect.objectContaining({
        review: undefined,
        decision: { outcome: "request_changes", counts: { blocking: 1, should_fix: 0, nit: 0 } },
      }),
    ]);
  });

  it("posts a review on the first live run even when a shadow run recorded the same decision (NIC-1141)", async () => {
    const h = harness();
    await addOther();
    // Shadow mode: the decision and label are recorded, but nothing is on GitHub.
    h.deps.shadow = true;
    const { posted: first } = await review(h, 1);
    expect(first).toMatchObject({ event: "APPROVE", reviewed: true });
    expect(h.runs.pr.reviewLive).toBeUndefined();
    headSha = await commit({ "src/other.ts": "export const rate = 5;\n" }, "unrelated");

    // Live, same decision and label: it posts its own review, since the recorded one never was.
    h.deps.shadow = false;
    const { posted } = await review(h, 2);
    expect(posted).toMatchObject({ event: "APPROVE", reviewed: true });
    expect(reviews(h)).toBe(2);
    // From then on the record is GitHub's, and quiet runs go by it as before (the test above).
    expect(h.runs.pr.reviewLive).toBe(true);
  });

  describe("explain answered by the explainer", () => {
    function withExplain(h: ReturnType<typeof harness>, kind: "explain" | "explain_pr") {
      const writes: string[] = [];
      const marked: Record<string, string[]> = {};
      let pending = true;
      h.deps.replies = {
        add: async () => true,
        take: async (_id, _limit, what) => {
          const row = h.findings.rows[0];
          return what === "explain" && pending && row !== undefined
            ? [
                {
                  id: "x1",
                  findingId: row.id,
                  commentId: 777,
                  author: "dev",
                  body: "@lgtmoose explain",
                  attempts: 0,
                  kind,
                },
              ]
            : [];
        },
        finish: async (ids, status) => {
          if (ids.length > 0) pending = false;
          marked[status] = [...(marked[status] ?? []), ...ids];
        },
        failed: async () => {},
      };
      const github = h.deps.github.bind(h.deps);
      h.deps.github = async (installationId) => ({
        ...(await github(installationId)),
        conversation: {
          reply: async (_target, root, body) => {
            writes.push(`reply ${root}: ${body}`);
          },
          comment: async (_target, body) => {
            writes.push(`comment: ${body}`);
          },
          resolveThread: async (id) => {
            writes.push(`resolve ${id}`);
          },
        },
      });
      return { writes, marked };
    }

    async function explainedRun(
      h: ReturnType<typeof harness>,
      n: number,
      explanation: NonNullable<BatchOutput["explanation"]> | undefined,
    ) {
      const prepared = await prepare(h.deps, { ...JOB, requested: "explain" }, exec(n), {
        ...SETTINGS,
        maxExplanations: 5,
      });
      const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
      const explains = new Set((manifest.explanations ?? []).map((job) => job.index));
      const answer = (index: number) =>
        explanation === undefined
          ? { version: 1, index, error: "rate limited", transcriptKeys: [] }
          : { version: 1, index, explanation, transcriptKeys: [] };
      for (const batch of prepared.batches) {
        h.objects.set(
          runKeys(prepared.runId).batchOutput(batch.index),
          JSON.stringify(
            explains.has(batch.index)
              ? answer(batch.index)
              : output({ index: batch.index, findings: [] }),
          ),
        );
      }
      return { prepared, manifest, posted: await post(h.deps, prepared.runId) };
    }

    it("answers in the finding's thread on the fast tier, and reuses the answer at the head", async () => {
      const h = harness({ commentIds: true });
      await review(h, 1, [finding()]);
      const x = withExplain(h, "explain");

      const { prepared, manifest } = await explainedRun(h, 2, {
        text: "The bound stops one short, so @dev's last item is never added.",
        line: 3,
      });

      const [job] = manifest.explanations ?? [];
      expect(job).toMatchObject({ replyId: "x1", kind: "explain", threadRootId: 1000 });
      const input = JSON.parse(
        h.objects.get(runKeys(prepared.runId).batchInput(job?.index ?? -1)) ?? "{}",
      ) as Record<string, unknown>;
      expect(input).toMatchObject({ role: "explain", tier: "fast" });
      expect(input.prompt).toContain('<untrusted source="finding">');
      expect(x.writes).toHaveLength(1);
      expect(x.writes[0]).toMatch(/^reply 1000: /);
      expect(x.writes[0]).toContain("\\@\u2060dev");
      expect(x.marked).toMatchObject({ judged: ["x1"] });

      // Asked again at the same head: no explainer batch, the kept answer.
      const again = withExplain(h, "explain_pr");
      const second = await explainedRun(h, 3, undefined);
      expect(second.manifest.explanations?.[0]?.index).toBeUndefined();
      expect(second.manifest.explanations?.[0]?.cached).toBeDefined();
      expect(again.writes[0]).toMatch(/^comment: /);
      expect(again.writes[0]).toContain("The bound stops one short");
    });

    it("replies with the stored finding when the explainer fails", async () => {
      const h = harness({ commentIds: true });
      await review(h, 1, [finding()]);
      const x = withExplain(h, "explain");
      await explainedRun(h, 2, undefined);
      expect(x.writes[0]).toContain("Severity: blocking.");
      expect(x.marked).toMatchObject({ judged: ["x1"] });
    });
  });

  describe("replies judged by the reply judge", () => {
    /** Wires the reply judge's stores and GitHub writes into a harness, with one pending reply. */
    function withReplies(h: ReturnType<typeof harness>, reply: { body: string; author: string }) {
      const writes: string[] = [];
      const marked: Record<string, string[]> = {};
      const events: string[] = [];
      let pending = true;
      h.deps.replies = {
        add: async () => true,
        take: async () => {
          const row = h.findings.rows[0];
          return pending && row !== undefined
            ? [{ id: "r1", findingId: row.id, commentId: 555, attempts: 0, ...reply }]
            : [];
        },
        finish: async (ids, status) => {
          if (ids.length > 0) pending = false;
          marked[status] = [...(marked[status] ?? []), ...ids];
        },
        failed: async (ids) => {
          marked.failed = [...(marked.failed ?? []), ...ids];
        },
      };
      h.findings.closeForReply = async (id, status) => {
        const row = h.findings.rows.find((candidate) => candidate.id === id);
        if (row === undefined || (row.status !== "open" && row.status !== "outdated")) return false;
        row.status = status;
        return true;
      };
      h.findings.recordReply = async (id, type) => {
        events.push(`${id} ${type}`);
      };
      h.findings.disputesAnswered = async () => new Set();
      h.findings.fixedCommentIds = async () =>
        h.findings.rows.flatMap((row) =>
          row.status === "fixed" && row.githubCommentId !== undefined ? [row.githubCommentId] : [],
        );
      const github = h.deps.github.bind(h.deps);
      h.deps.github = async (installationId) => ({
        ...(await github(installationId)),
        conversation: {
          reply: async (_target, root, body) => {
            writes.push(`reply ${root}: ${body}`);
          },
          comment: async (_target, body) => {
            writes.push(`comment: ${body}`);
          },
          resolveThread: async (id) => {
            writes.push(`resolve ${id}`);
          },
        },
      });
      return { writes, marked, events };
    }

    /** Prepares a run for replies and writes each batch's output: the judge's for its own. */
    async function judgedRun(
      h: ReturnType<typeof harness>,
      n: number,
      judgement: NonNullable<BatchOutput["judgement"]>,
      found: Finding[] = [],
    ) {
      const prepared = await prepare(h.deps, { ...JOB, requested: "replies" }, exec(n), {
        ...SETTINGS,
        maxReplyJudgements: 10,
      });
      const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
      const judges = new Set((manifest.judgements ?? []).map((judge) => judge.index));
      for (const batch of prepared.batches) {
        h.objects.set(
          runKeys(prepared.runId).batchOutput(batch.index),
          JSON.stringify(
            judges.has(batch.index)
              ? { version: 1, index: batch.index, judgement, transcriptKeys: [] }
              : output({ index: batch.index, findings: found }),
          ),
        );
      }
      return { prepared, manifest, posted: await post(h.deps, prepared.runId) };
    }

    it("closes a fix the judge saw at head, resolves its thread and approves", async () => {
      const h = harness({
        commentIds: true,
        threads: () => [{ resolved: false, firstCommentId: 1000, id: "PRRT_1" }],
      });
      await review(h, 1, [finding()]);
      expect(h.findings.rows).toMatchObject([{ status: "open", githubCommentId: 1000 }]);
      const r = withReplies(h, { body: "Fixed now.", author: "dev" });
      // The fix lands in the finding's file, away from the cited line.
      headSha = await commit(
        {
          "src/total.ts": HEAD_TOTAL.replace("sum += items[i].price;", "sum += items[i].price!;"),
        },
        "fix",
      );

      const { prepared, manifest, posted } = await judgedRun(h, 2, {
        kind: "fixed",
        fixed_at_head: true,
      });

      const [judge] = manifest.judgements ?? [];
      expect(judge).toMatchObject({ replyId: "r1", commentId: 555, fileChanged: true });
      const input = JSON.parse(
        h.objects.get(runKeys(prepared.runId).batchInput(judge?.index ?? -1)) ?? "{}",
      ) as Record<string, unknown>;
      expect(input).toMatchObject({ role: "judge", tier: "fast" });
      expect(input.prompt).toContain('<untrusted source="reply">\nFixed now.');
      expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
      expect(posted).toMatchObject({ event: "APPROVE" });
      expect(r.writes).toEqual(["resolve PRRT_1"]);
      expect(r.marked).toMatchObject({ judged: ["r1"] });
    });

    /** Our inline comment on the loop finding, as GitHub lists it among the PR's comments. */
    const ourComment = (): PullComment => ({
      id: 1000,
      author: "lgtmoose[bot]",
      authorType: "bot",
      body: "**Loop skips the last item**\n\nThe bound drops the last item from the total.",
      path: "src/total.ts",
      line: 3,
      side: "RIGHT",
    });
    const touchTotal = async (to: string) => {
      headSha = await commit(
        { "src/total.ts": HEAD_TOTAL.replace("sum += items[i].price;", `sum += ${to};`) },
        `touch ${to}`,
      );
    };

    /** A harness whose PR lists our comment once run 1 has posted it. */
    function withOurComment() {
      let posted = false;
      const h = harness({
        commentIds: true,
        threads: () => [{ resolved: false, firstCommentId: 1000, id: "PRRT_1" }],
        comments: () => (posted ? [ourComment()] : []),
      });
      return {
        h,
        first: async () => {
          await review(h, 1, [finding()]);
          posted = true;
          expect(h.findings.rows).toMatchObject([{ githubCommentId: 1000 }]);
        },
      };
    }

    it("reserves and settles a conversation-only run's judge batches (NIC-1079)", async () => {
      const h = harness({
        commentIds: true,
        threads: () => [{ resolved: false, firstCommentId: 1000, id: "PRRT_1" }],
        config: "review:\n  on_push: manual\n",
      });
      await review(h, 1, [finding()]);
      withReplies(h, { body: "Fixed now.", author: "dev" });
      await touchTotal("items[i].price!");
      const spend = memorySpend({ averageBatchUsd: undefined });
      h.deps.spend = { store: spend.store, budgets: budgetsSchema.parse({ monthlyUsd: 10 }) };

      const { prepared, manifest } = await judgedRun(h, 2, { kind: "fixed", fixed_at_head: true });

      expect(manifest.conversationOnly).toBe(true);
      const judges = (manifest.judgements ?? []).map((judge) => judge.index);
      expect(judges).toHaveLength(1);
      const row = spend.reserved.get(prepared.runId);
      expect(row?.dispatched).toEqual(judges.map((index) => ({ index, tier: "fast" })));
      // Settled by its post at the fast tier's default (the judge's output reported no usage).
      expect(row?.settled).toBeCloseTo((60_000 * 1 + 6_000 * 5) / 1e6, 6);
    });

    it("with on_push: manual, judges a reply after a push without reviewing the new commit", async () => {
      const h = harness({
        commentIds: true,
        threads: () => [{ resolved: false, firstCommentId: 1000, id: "PRRT_1" }],
        config: "review:\n  on_push: manual\n",
      });
      await review(h, 1, [finding()]);
      const firstHead = headSha;
      const r = withReplies(h, { body: "Fixed now.", author: "dev" });
      // A push the repo doesn't review on its own, then a reply on the old finding.
      await touchTotal("items[i].price!");

      const { prepared, manifest, posted } = await judgedRun(h, 2, {
        kind: "fixed",
        fixed_at_head: true,
      });

      // Only the judge ran: no reviewer batch, no ticket batch.
      expect(manifest.conversationOnly).toBe(true);
      expect(manifest.review.jobs).toEqual([]);
      const judges = (manifest.judgements ?? []).map((judge) => judge.index);
      expect(prepared.batches.map((batch) => batch.index)).toEqual(judges);
      expect(judges).toHaveLength(1);
      // The reply is judged and answered. The fix isn't taken: nothing reviewed the new commit.
      expect(r.marked).toMatchObject({ judged: ["r1"] });
      expect(h.findings.rows).toMatchObject([{ status: "open" }]);
      expect(r.writes).toHaveLength(1);
      expect(r.writes[0]).toMatch(/^reply 1000: .*wasn't reviewed again in this run/);
      // No review, and the PR's last reviewed head stays the first one.
      expect(posted).toMatchObject({ posted: false, reviewed: false });
      expect(reviews(h)).toBe(1);
      expect(h.runs.runs.get(prepared.runId)?.status).toBe("superseded");
      expect(h.runs.runs.get(RUN_ID)).toMatchObject({ status: "succeeded", headSha: firstHead });
      // The new commit waits, as a push's run would say.
      const waiting = shadowRecords(h.objects, "check-run").filter(
        (check) => check.title === "Waiting for a trigger",
      );
      expect(waiting).toMatchObject([{ head_sha: headSha, conclusion: "action_required" }]);
      expect(shadowRecords(h.objects, "summary-comment")).toHaveLength(1);
    });

    it("keeps a fix open when the same run's reviewer finds it again", async () => {
      const { h, first } = withOurComment();
      await first();
      const r = withReplies(h, { body: "Fixed: the bound is right now.", author: "dev" });
      // The author touches the file and says it's fixed; the judge is persuaded.
      await touchTotal("items[i].price!");

      const { prepared, posted } = await judgedRun(h, 2, { kind: "fixed", fixed_at_head: true }, [
        finding(),
      ]);

      // The reviewer read the file without our comment on it...
      expect(promptOf(h, prepared.runId)).toContain("src/total.ts");
      expect(promptOf(h, prepared.runId)).not.toContain("The bound drops the last item");
      // ...raised it again, and wins: still open, no approval, one "still there" reply.
      expect(h.findings.rows).toMatchObject([{ status: "open" }]);
      expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
      expect(r.writes).toHaveLength(1);
      expect(r.writes[0]).toMatch(/^reply 1000: The review of this commit found this again/);
      // Not posted a second time: it's the same finding.
      expect(reviews(h)).toBe(1);
    });

    it("reopens a fixed finding the reviewer raises again in a later run", async () => {
      const { h, first } = withOurComment();
      await first();
      withReplies(h, { body: "Fixed now.", author: "dev" });
      await touchTotal("items[i].price!");
      await judgedRun(h, 2, { kind: "fixed", fixed_at_head: true });
      expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);

      await touchTotal("items[i].price ?? 0");
      const { prepared, posted } = await review(h, 3, [finding()]);

      // Our comment on a fixed finding doesn't stand for it: not in the prompt, and not a
      // duplicate. The re-raise is posted, reopens the finding and counts.
      expect(promptOf(h, prepared.runId)).not.toContain("The bound drops the last item");
      expect(h.findings.rows).toMatchObject([{ status: "open" }]);
      expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
    });

    it("keeps a blocking finding open when the author says it's fixed but nothing changed", async () => {
      const h = harness({ commentIds: true });
      await review(h, 1, [finding()]);
      const r = withReplies(h, { body: "Done, trust me.", author: "dev" });

      // Same head: the run for replies isn't covered by the head's review.
      const { manifest, posted } = await judgedRun(h, 2, { kind: "fixed", fixed_at_head: true });

      expect(manifest.judgements?.[0]?.fileChanged).toBe(false);
      expect(h.findings.rows).toMatchObject([{ status: "open" }]);
      expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
      expect(posted.coveredBy).toBeUndefined();
      expect(r.writes).toHaveLength(1);
      expect(r.writes[0]).toMatch(/^reply 1000: .*hasn't changed since this was raised/);
      expect(r.writes[0]).toContain("<!-- lgtmoose:reply -->");
      expect(r.events).toEqual([`${h.findings.rows[0]?.id} replied`]);
    });

    it("counts a failed judge as an attempt and leaves the finding as it is", async () => {
      const h = harness({ commentIds: true });
      await review(h, 1, [finding()]);
      const r = withReplies(h, { body: "Why is this a problem?", author: "dev" });
      const prepared = await prepare(h.deps, { ...JOB, requested: "replies" }, exec(2), {
        ...SETTINGS,
        maxReplyJudgements: 10,
      });
      for (const batch of prepared.batches) {
        h.objects.set(
          runKeys(prepared.runId).batchOutput(batch.index),
          JSON.stringify({
            version: 1,
            index: batch.index,
            error: "timeout: slow",
            transcriptKeys: [],
          }),
        );
      }
      await post(h.deps, prepared.runId);
      expect(r.marked).toMatchObject({ failed: ["r1"] });
      expect(r.writes).toEqual([]);
      expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    });
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

  it("doesn't let the PR's author clear a blocking finding by resolving its thread", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    await review(h, 1, [finding()]);

    // The author (`dev`) resolves it: it still counts, and the PR isn't approved.
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "dev" }];
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "unrelated");
    const byAuthor = await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(byAuthor.posted).toMatchObject({ event: "REQUEST_CHANGES" });

    // Someone with read access only: still counts.
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "fan" }];
    headSha = await commit({ "src/other.ts": "export const rate = 7;\n" }, "unrelated, again");
    await review(h, 3);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);

    // A maintainer resolves it: it's out of the decision.
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "lead" }];
    headSha = await commit({ "src/other.ts": "export const rate = 8;\n" }, "unrelated, once more");
    const byLead = await review(h, 4);
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);
    expect(byLead.posted).toMatchObject({ event: "APPROVE" });
  });

  it("lets the PR's author resolve a should_fix finding", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    await review(h, 1, [finding({ severity: "should_fix" })]);
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "dev" }];
    headSha = await commit({ "src/other.ts": "export const rate = 6;\n" }, "unrelated");
    await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "resolved_by_human" }]);
  });

  it("follows our comment's thread: resolved takes the finding out, unresolved puts it back", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    const first = await review(h, 1, [finding()]);
    expect(first.posted).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(h.findings.rows).toMatchObject([{ status: "open", githubCommentId: 1000 }]);

    // A person resolves the thread; the next run approves, with the finding left alone.
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "lead" }];
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

  it("reviews every file afresh after a force-push loses the earlier review's commit", async () => {
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
    // As on a first review: src/total.ts is the same blob as reviewed, but its earlier review
    // can't be compared with.
    expect(promptOf(h, prepared.runId)).toContain("src/other.ts");
    expect(promptOf(h, prepared.runId)).toContain("src/total.ts");
    expect(
      h.runs.runs
        .get(first.runId)
        ?.files.map((file) => file.path)
        .toSorted(),
    ).toEqual(["src/other.ts", "src/total.ts"]);
    expect(old).not.toBe(headSha);
  });

  it("outdates a finding whose commit is gone after a force-push, and reopens it if raised again", async () => {
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

    // Its line can't be followed exactly, so it doesn't stand; the PR is reviewed afresh.
    const second = await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(second.posted).toMatchObject({ event: "APPROVE" });

    // Raised again (the same finding): reopened at its new place, not a second row, and at the
    // more severe of the two severities.
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("sum += items[i].price;", "sum += items[i].price ?? 1;"),
      },
      "touch total",
    );
    const third = await review(h, 3, [finding()]);
    expect(h.findings.rows).toMatchObject([{ status: "open", severity: "blocking" }]);
    expect(third.posted).toMatchObject({ event: "REQUEST_CHANGES" });
  });

  it("doesn't follow a closed finding on a file the PR no longer changes", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    await review(h, 1, [finding()]);
    const raisedAt = headSha;
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "lead" }];
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

  it("outdates an old-side finding whose raised-at commit shares no history with the base", async () => {
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

    // Its lines can't be followed exactly: it doesn't stand.
    await expect(review(h, 2)).resolves.toBeDefined();
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
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
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "lead" }];
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
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "lead" }];
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
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "lead" }];
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

  const REWRITTEN = [
    "export function grandTotal(orders: Order[]): number {",
    "  return orders.reduce((all, order) => all + order.amount * order.rate, 0);",
    "}",
    "",
    "export function averageOrder(orders: Order[]): number {",
    "  return grandTotal(orders) / orders.length;",
    "}",
    "",
  ].join("\n");
  // On the base's `return sum;`, which the rewrite deletes.
  const droppedReturn = finding({
    side: "LEFT",
    line: 6,
    title: "Return was removed",
    evidence: "return sum;",
  });

  it("keeps an old-side finding in a rewritten file the PR then renames", async () => {
    const h = harness();
    headSha = await commit({ "src/total.ts": REWRITTEN }, "rewrite total");
    await review(h, 1, [droppedReturn]);
    // Renamed with a small edit: on the head side a rename, on the base side src/total.ts is
    // still deleted, its return with it.
    await git(work, "mv", "src/total.ts", "src/orders.ts");
    headSha = await commit({ "src/orders.ts": `// Order totals.\n${REWRITTEN}` }, "rename");

    const again = await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(again.posted).toMatchObject({ event: "REQUEST_CHANGES" });
  });

  /** The PR renames src/total.ts to src/sum.ts and drops its return: an old-side finding on it. */
  async function renamedWithDroppedReturn() {
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    headSha = await commit({ "src/sum.ts": HEAD_TOTAL.replace("  return sum;\n", "") }, "rename");
    return finding({
      path: "src/sum.ts",
      side: "LEFT",
      line: 6,
      title: "Return was removed",
      evidence: "return sum;",
    });
  }

  it("keeps an old-side finding through a second rename by the PR", async () => {
    const h = harness();
    const left = await renamedWithDroppedReturn();
    await review(h, 1, [left]);
    // Renamed again; the base's return is still deleted.
    await git(work, "mv", "src/sum.ts", "src/amount.ts");
    headSha = await commit({}, "rename again");

    const again = await review(h, 2, [{ ...left, path: "src/amount.ts" }]);
    expect(h.findings.rows).toMatchObject([{ status: "open", basePath: "src/total.ts" }]);
    expect(again.posted).toMatchObject({ event: "REQUEST_CHANGES", findings: 0 });
  });

  /** The PR deletes src/total.ts's return: an old-side finding on it, then its commit is gone. */
  async function droppedReturnThenForcePushed(
    h: ReturnType<typeof harness>,
    redo: () => Promise<void>,
  ) {
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("  return sum;\n", "") },
      "drop return",
    );
    await review(h, 1, [droppedReturn]);
    await redo();
    await git(remote, "reflog", "expire", "--expire=now", "--all");
    await git(remote, "gc", "--quiet", "--prune=now");
  }

  it("outdates an old-side finding whose commit is gone once the PR keeps its line", async () => {
    const h = harness();
    await droppedReturnThenForcePushed(h, async () => {
      // Redone: still changes the file, but no longer deletes the return.
      await git(work, "reset", "--quiet", "--hard", baseSha);
      headSha = await commit({ "src/total.ts": HEAD_TOTAL }, "redone, return kept");
    });

    const again = await review(h, 2);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(again.posted).toMatchObject({ event: "APPROVE" });
  });

  it("keeps a resolved old-side finding resolved through a second rename by the PR", async () => {
    let threads: ReviewThread[] = [];
    const h = harness({ commentIds: true, threads: () => threads });
    const left = await renamedWithDroppedReturn();
    await review(h, 1, [left]);
    threads = [{ resolved: true, firstCommentId: 1000, resolvedBy: "lead" }];
    await git(work, "mv", "src/sum.ts", "src/amount.ts");
    headSha = await commit({}, "rename again");

    const again = await review(h, 2, [{ ...left, path: "src/amount.ts" }]);
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

  const dead = () => Object.assign(new Error("Task Timed Out"), { name: "TaskTimedOut" });
  const prepareCommand = {
    command: "prepare" as const,
    executionArn: EXECUTION,
    job: JSON.stringify(JOB),
    taskToken: "t",
  };

  it("counts a post attempt before anything that can fail", async () => {
    const h = harness();
    // No such run: the post fails at once, after it was counted.
    await runCommand(
      h.deps,
      { command: "post", executionArn: EXECUTION, runId: RUN_ID, taskToken: "t", attempts: 4 },
      { ...SETTINGS, shadow: true },
    );
    expect(h.tokens.failed).toHaveLength(1);
    expect(JSON.parse(h.objects.get(runKeys(RUN_ID).postAttempts) ?? "{}")).toEqual({
      attempts: 1,
    });
  });

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

/** The spend ledger in memory: what's spent, and what runs reserve and settle. */
function memorySpend(spent: Partial<SpendSnapshot> = {}, lastCapped?: string) {
  const reserved = new Map<
    string,
    {
      costUsd: number;
      batches: number;
      dispatched?: readonly { index: number; tier: string }[];
      settled?: number;
    }
  >();
  const capped = new Map<string, string>();
  const snapshot = (): SpendSnapshot => ({
    prDayRuns: 0,
    prDayUsd: 0,
    repoMonthUsd: 0,
    monthUsd: 0,
    averageBatchUsd: 1,
    ...spent,
  });
  const store: SpendStore = {
    snapshot: async () => snapshot(),
    async reserve(runId, _target, _now, decide) {
      const seen = snapshot();
      const decision = decide(seen);
      if (decision !== undefined && decision.batches > 0 && !reserved.has(runId)) {
        reserved.set(runId, {
          costUsd: decision.costUsd,
          batches: decision.batches,
          dispatched: decision.dispatched ?? [],
        });
      }
      return { snapshot: seen, decision };
    },
    async settle(runId, costUsd) {
      const row = reserved.get(runId);
      if (row === undefined) return undefined;
      const wasSettled = row.settled !== undefined;
      const reservedUsd = row.settled ?? row.costUsd;
      row.settled = costUsd;
      return { repo: "acme/shop", month: "2026-11", reservedUsd, wasSettled };
    },
    markCapped: async (runId, kind) => {
      capped.set(runId, kind);
    },
    lastCapped: async () => lastCapped,
    // Every unsettled one, however young: the cut-off is the store's to apply.
    unsettled: async () =>
      [...reserved]
        .filter(([, row]) => row.settled === undefined)
        .map(([runId, row]) => ({
          runId,
          costUsd: row.costUsd,
          batches: row.batches,
          dispatched: [...(row.dispatched ?? [])],
        })),
    monthTotals: async () => ({ monthUsd: 0, repos: new Map() }),
  };
  return { store, reserved, capped };
}

describe("spend caps (NIC-1079)", () => {
  const budgets = (input: unknown) => budgetsSchema.parse(input);

  it("reserves a run's estimate and settles it at what its batches reported", async () => {
    const h = harness();
    const spend = memorySpend();
    h.deps.spend = { store: spend.store, budgets: budgets({ monthlyUsd: 100 }) };
    const result = await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    expect(result.batches).toEqual([{ index: 0 }]);
    expect(spend.reserved.get(RUN_ID)).toEqual({
      costUsd: 1,
      batches: 1,
      dispatched: [{ index: 0, tier: "standard" }],
    });
    h.objects.set(
      runKeys(RUN_ID).batchOutput(0),
      JSON.stringify(output({ usage: { inputTokens: 100_000, outputTokens: 10_000 } })),
    );
    await post(h.deps, RUN_ID);
    // 100k input and 10k output at the standard tier's $3 and $15 a million.
    expect(spend.reserved.get(RUN_ID)?.settled).toBeCloseTo(0.45, 6);
    expect(spend.capped.size).toBe(0);
  });

  it("settles a run a newer push stopped, at what its batches reported, without a post", async () => {
    const h = harness();
    const spend = memorySpend();
    const caps = budgets({ monthlyUsd: 100 });
    h.deps.spend = { store: spend.store, budgets: caps };
    await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    // The batch ran and wrote its output; then a push stopped the execution before post.
    h.objects.set(
      runKeys(RUN_ID).batchOutput(0),
      JSON.stringify(output({ usage: { inputTokens: 200_000, outputTokens: 20_000 } })),
    );
    const logs: string[] = [];
    const settled = await settleStaleSpend(
      { store: spend.store, budgets: caps },
      { getText: async (key) => h.objects.get(key) },
      new Date(),
      (message) => logs.push(message),
      0,
    );
    expect(settled).toBe(1);
    // 200k input and 20k output at $3 and $15 a million, not the $1 estimate.
    expect(spend.reserved.get(RUN_ID)?.settled).toBeCloseTo(0.9, 6);
    expect(logs).toContain("spend settled without a post");
    // Settled once: the next reconcile has nothing to do.
    expect(
      await settleStaleSpend(
        { store: spend.store, budgets: caps },
        h.deps.store,
        new Date(),
        () => undefined,
        0,
      ),
    ).toBe(0);
  });

  it("dispatches nothing past a cap, and posts an incomplete review that says which", async () => {
    const h = harness();
    const spend = memorySpend({ monthUsd: 100 });
    h.deps.spend = { store: spend.store, budgets: budgets({ monthlyUsd: 100 }) };
    const result = await prepare(h.deps, JOB, EXECUTION, SETTINGS);
    expect(result).toMatchObject({ superseded: false, batches: [] });
    expect(h.objects.has(runKeys(RUN_ID).batchInput(0))).toBe(false);
    expect(spend.reserved.size).toBe(0);
    expect(spend.capped.get(RUN_ID)).toBe("monthly");
    const manifest = JSON.parse(h.objects.get(runKeys(RUN_ID).prepared) ?? "") as RunManifest;
    expect(manifest.spendCap).toMatchObject({ kind: "monthly", batches: [0] });

    expect(await post(h.deps, RUN_ID)).toMatchObject({ posted: true, complete: false });
    const [check] = shadowRecords(h.objects, "check-run");
    expect(check).toMatchObject({ title: "Spend cap reached", conclusion: "action_required" });
    const [summary] = shadowRecords(h.objects, "summary-comment");
    // Escaped, as every reason in the summary is.
    expect(String(summary?.body)).toContain("monthly spend cap of \\$100\\.00");
    expect(String(summary?.body)).not.toContain("failed");
    const [review] = shadowRecords(h.objects, "review");
    expect(review).toMatchObject({ event: "COMMENT" });
  });

  it("posts nothing when the head's last posted run was stopped by the same cap", async () => {
    const h = harness();
    const spend = memorySpend({ monthUsd: 100 }, "monthly");
    h.deps.spend = { store: spend.store, budgets: budgets({ monthlyUsd: 100 }) };
    expect(await prepare(h.deps, JOB, EXECUTION, SETTINGS)).toMatchObject({ superseded: true });
    expect(h.runs.runs.get(RUN_ID)?.status).toBe("superseded");
    // Before the clone: no checkout was written.
    expect(h.files.size).toBe(0);
  });

  it("lifts the PR's caps for a review asked for by someone with write access", async () => {
    const spent = { prDayRuns: 5 };
    const caps = budgets({ perPullRequest: { runsPerDay: 5 } });
    const asked = { ...JOB, requested: "review" as const };

    const lead = harness();
    lead.deps.spend = { store: memorySpend(spent).store, budgets: caps };
    expect(
      (await prepare(lead.deps, { ...asked, actor: "lead" }, EXECUTION, SETTINGS)).batches,
    ).toEqual([{ index: 0 }]);

    // Read access, or no command at all: the cap stands.
    for (const job of [
      { ...asked, actor: "reader" },
      { ...JOB, actor: "lead" },
    ]) {
      const h = harness();
      const spend = memorySpend(spent);
      h.deps.spend = { store: spend.store, budgets: caps };
      expect((await prepare(h.deps, job, EXECUTION, SETTINGS)).batches).toEqual([]);
      expect(spend.capped.get(RUN_ID)).toBe("pr_runs");
    }
  });

  it("never lifts the monthly caps, whoever asks", async () => {
    const h = harness();
    const spend = memorySpend({ repoMonthUsd: 20 });
    h.deps.spend = { store: spend.store, budgets: budgets({ perRepoMonthlyUsd: 20 }) };
    const job = { ...JOB, requested: "review" as const, actor: "lead" };
    expect((await prepare(h.deps, job, EXECUTION, SETTINGS)).batches).toEqual([]);
    expect(spend.capped.get(RUN_ID)).toBe("repo_monthly");
  });
});

describe("carried findings rechecked (NIC-1120)", { timeout: 30_000 }, () => {
  const exec = (n: number) => `${EXECUTION}-${n}`;

  /** A harness whose store can close findings on the recheck's word, and GitHub writes kept. */
  function rechecking(setup: Setup = {}) {
    const h = harness(
      Object.assign(setup, {
        commentIds: true,
        threads: () => [
          { resolved: false, firstCommentId: 1000, id: "PRRT_1" },
          { resolved: false, firstCommentId: 1001, id: "PRRT_2" },
        ],
      }),
    );
    const writes: string[] = [];
    /**
     * What the next replies and resolves do, in order: fail with the error, as GitHub would, or
     * go through for `undefined`. Once the list is empty, every one goes through.
     */
    const fail = { replies: [] as (Error | undefined)[], resolves: [] as (Error | undefined)[] };
    // Our own closes, by finding and commit: one closed already is ours only when it's one.
    const closedBy = new Map<string, string>();
    h.findings.closeFixed = async (id, sha) => {
      const row = h.findings.rows.find((candidate) => candidate.id === id);
      if (row === undefined) return "theirs";
      if (row.status !== "open" && row.status !== "outdated") {
        return row.status === "fixed" && closedBy.get(id) === sha ? "ours" : "theirs";
      }
      row.status = "fixed";
      closedBy.set(id, sha);
      return "closed";
    };
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (installationId) => ({
      ...(await github(installationId)),
      conversation: {
        reply: async (_target, root, body) => {
          const error = fail.replies.shift();
          if (error !== undefined) throw error;
          writes.push(`reply ${root}: ${body}`);
        },
        comment: async (_target, body) => {
          writes.push(`comment: ${body}`);
        },
        resolveThread: async (id) => {
          const error = fail.resolves.shift();
          if (error !== undefined) throw error;
          writes.push(`resolve ${id}`);
        },
      },
    });
    return { h, writes, fail };
  }

  /**
   * Prepares and posts run `n`: review batches find `found`, and the recheck batch (if any)
   * answers with `verdicts`, or writes nothing when they're left out.
   */
  async function run(
    h: ReturnType<typeof harness>,
    n: number,
    found: Finding[] = [],
    verdicts?: NonNullable<BatchOutput["verdicts"]>,
    job: Parameters<typeof prepare>[1] = JOB,
  ) {
    const prepared = await prepare(h.deps, job, exec(n), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    for (const batch of prepared.batches) {
      const key = runKeys(prepared.runId).batchOutput(batch.index);
      if (batch.index !== manifest.recheck?.index) {
        h.objects.set(key, JSON.stringify(output({ index: batch.index, findings: found })));
      } else if (verdicts !== undefined) {
        h.objects.set(
          key,
          JSON.stringify({ version: 1, index: batch.index, verdicts, transcriptKeys: [] }),
        );
      }
    }
    return { prepared, manifest, posted: await post(h.deps, prepared.runId) };
  }

  /** The fix lands in another file of the same folder: the finding's line is untouched. */
  const fixElsewhere = async () => {
    headSha = await commit(
      { "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n" },
      "fix in the caller",
    );
  };

  it("closes a blocking finding fixed in another file, replies, resolves and approves", async () => {
    const { h, writes } = rechecking();
    const { posted: first } = await run(h, 1, [finding()]);
    expect(first).toMatchObject({ event: "REQUEST_CHANGES" });
    await fixElsewhere();

    const { prepared, manifest, posted } = await run(
      h,
      2,
      [],
      [
        {
          id: "F1",
          confirmed: false,
          reason: "src/checkout.ts line 1 adds the item the loop skips.",
        },
      ],
    );

    expect(manifest.recheck).toMatchObject({
      changed: ["src/checkout.ts"],
      targets: [{ id: "F1", findingId: "f0", severity: "blocking", githubCommentId: 1000 }],
    });
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(manifest.recheck?.index ?? -1)) ?? "{}",
    ) as Record<string, unknown>;
    expect(input).toMatchObject({ role: "recheck", tier: "fast" });
    expect(input.prompt).toContain('<untrusted source="finding">');
    expect(input.prompt).toContain("+++ b/src/checkout.ts");
    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
    expect(posted).toMatchObject({ event: "APPROVE" });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^reply 1000: This looks fixed at [0-9a-f]{7}/);
    // The verdict's reason, escaped: it's model output.
    expect(writes[0]).toContain("src\\/checkout\\.ts line 1 adds the item");
    expect(writes[0]).toContain("<!-- lgtmoose:reply -->");
    expect(writes[1]).toBe("resolve PRRT_1");
  });

  it("in shadow mode, logs the reply and resolve a fixed finding would get, and writes neither", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    h.deps.shadow = true;

    const { posted } = await run(
      h,
      2,
      [],
      [
        {
          id: "F1",
          confirmed: false,
          reason: "src/checkout.ts line 1 adds the item the loop skips.",
        },
      ],
    );

    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
    expect(posted).toMatchObject({ event: "APPROVE" });
    expect(writes).toEqual([]);
    const logged = h.logFields.filter(
      (entry) => entry.message === "shadow: would reply and resolve",
    );
    expect(logged).toEqual([
      {
        message: "shadow: would reply and resolve",
        runId: expect.any(String),
        findingId: "f0",
        sha: headSha,
        reply: expect.stringMatching(/^This looks fixed at [0-9a-f]{7}, /),
      },
    ]);
    // The reply carries the recheck's reason, never the finding's own text.
    expect(JSON.stringify(logged)).not.toContain(finding().body);
  });

  describe("going live after shadow mode (NIC-1141)", () => {
    /** The summaries recorded, all or one run's. */
    const summaries = (h: ReturnType<typeof harness>, runId?: string) =>
      JSON.stringify(
        [...h.objects]
          .filter(
            ([key]) =>
              key.startsWith("shadow/") &&
              key.endsWith("-summary-comment.json") &&
              (runId === undefined || key.includes(`/${runId}/`)),
          )
          .map(([, body]) => body),
      );

    it("retires unanswered shadow findings on the first live run, and posts one raised again", async () => {
      const setup: Setup = {};
      const { h, writes } = rechecking(setup);
      // Shadow mode: nothing reaches GitHub, so the finding gets no comment.
      setup.commentIds = false;
      h.deps.shadow = true;
      const { posted: shadowRun } = await run(h, 1, [finding()]);
      expect(shadowRun).toMatchObject({ event: "REQUEST_CHANGES" });
      expect(h.findings.rows).toMatchObject([{ status: "open", shadowRun: true }]);
      expect(h.findings.rows[0]?.githubCommentId).toBeUndefined();

      // A second shadow run retires nothing.
      await fixElsewhere();
      await run(h, 2, []);
      expect(h.findings.rows).toMatchObject([{ status: "open", shadowRun: true }]);

      // Live: retired before the decision, so it doesn't count, and isn't rechecked.
      h.deps.shadow = false;
      setup.commentIds = true;
      headSha = await commit({ "src/other.ts": "export const other = 1;\n" }, "another change");
      const { prepared: first, manifest, posted: live } = await run(h, 3, []);
      expect(manifest.recheck).toBeUndefined();
      expect(h.findings.rows).toMatchObject([{ status: "shadow" }]);
      expect(live).toMatchObject({ event: "APPROVE" });
      expect(summaries(h, first.runId)).toContain(
        "1 finding from shadow mode was never posted and no longer counts",
      );
      expect(summaries(h, first.runId)).toContain("full review");
      expect(writes).toEqual([]);
      // A retry retires none, and the note comes from what's stored: the same.
      expect(await h.findings.retireShadowFindings?.("pr-1", headSha)).toBe(0);
      expect(await h.findings.retiredShadowFindings?.("pr-1")).toHaveLength(1);

      // Every summary says it until a full review: an incremental one at the next push too.
      headSha = await commit({ "src/other.ts": "export const other = 2;\n" }, "and another");
      const { prepared: next } = await run(h, 4, []);
      expect(summaries(h, next.runId)).toContain("never posted and no longer counts");

      // `full review`, as the summary says: raised again, posted as new with a comment, and it
      // counts. The full review's own summary has no note, nor does any after it.
      const { prepared: full, posted: again } = await run(h, 5, [finding()], undefined, {
        ...JOB,
        requested: "full_review" as const,
      });
      expect(summaries(h, full.runId)).not.toContain("from shadow mode");
      expect(await h.findings.retiredShadowFindings?.("pr-1")).toEqual([]);
      expect(again).toMatchObject({ event: "REQUEST_CHANGES" });
      expect(h.findings.rows).toHaveLength(1);
      expect(h.findings.rows[0]).toMatchObject({ status: "open" });
      expect(h.findings.rows[0]?.githubCommentId).toEqual(expect.any(Number));
      expect(h.findings.rows[0]?.shadowRun).toBeUndefined();
    });

    it("leaves a live finding without a comment open", async () => {
      const setup: Setup = {};
      const { h } = rechecking(setup);
      // Live, but its comment ID wasn't read back (or the comment was deleted on GitHub since).
      setup.commentIds = false;
      const { posted } = await run(h, 1, [finding()]);
      expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
      setup.commentIds = true;
      headSha = await commit({ "src/other.ts": "export const other = 1;\n" }, "another change");
      const { posted: next } = await run(h, 2, []);
      expect(h.findings.rows).toMatchObject([{ status: "open" }]);
      expect(h.findings.rows[0]?.shadowRun).toBeUndefined();
      expect(next).toMatchObject({ event: "REQUEST_CHANGES" });
      expect(summaries(h)).not.toContain("from shadow mode");
    });
  });

  it("keeps a finding the recheck still finds, or gave no verdict for, open", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    const { posted } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: true, reason: "src/total.ts line 3 still stops one short." }],
    );
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(writes).toEqual([]);

    // No output at all for the recheck batch: nothing closes either.
    headSha = await commit({ "src/checkout.ts": "export const none = 0;\n" }, "again");
    const { posted: again } = await run(h, 3, [], undefined);
    expect(again).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("closes a protected-category finding only when the verdict names the fix by its path", async () => {
    const authz = finding({ rule_category: "authz", title: "Total is computed for any caller" });
    const { h } = rechecking();
    await run(h, 1, [authz]);
    await fixElsewhere();
    await run(h, 2, [], [{ id: "F1", confirmed: false, reason: "This looks handled now." }]);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);

    // The file's name alone isn't its path.
    headSha = await commit({ "src/checkout.ts": "export const guarded = 1;\n" }, "guard");
    await run(
      h,
      3,
      [],
      [{ id: "F1", confirmed: false, reason: "checkout.ts line 1 now checks the caller first." }],
    );
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);

    headSha = await commit({ "src/checkout.ts": "export const guarded = 2;\n" }, "guard again");
    const { manifest } = await run(
      h,
      4,
      [],
      [
        {
          id: "F1",
          confirmed: false,
          reason: "src/checkout.ts line 1 now checks the caller first.",
        },
      ],
    );
    expect(manifest.recheck?.targets[0]?.related).toEqual(["src/checkout.ts"]);
    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
  });

  it("finishes the closes and writes every reply after an attempt dies part way", async () => {
    const { h, writes } = rechecking();
    const second = finding({
      line: 4,
      title: "Total adds the price before the discount",
      evidence: "sum += items[i].price;",
    });
    await run(h, 1, [finding(), second]);
    expect(h.findings.rows.map((row) => row.githubCommentId)).toEqual([1000, 1001]);
    await fixElsewhere();
    const close = h.findings.closeFixed?.bind(h.findings);
    let calls = 0;
    h.findings.closeFixed = async (id, sha) => {
      calls += 1;
      if (calls === 2) throw new Error("the database went away");
      return close?.(id, sha) ?? "theirs";
    };
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    const reason = "src/checkout.ts line 1 adds the item.";
    for (const batch of prepared.batches) {
      const verdicts = [
        { id: "F1", confirmed: false, reason },
        { id: "F2", confirmed: false, reason },
      ];
      h.objects.set(
        runKeys(prepared.runId).batchOutput(batch.index),
        JSON.stringify(
          batch.index === manifest.recheck?.index
            ? { version: 1, index: batch.index, verdicts, transcriptKeys: [] }
            : output({ index: batch.index, findings: [] }),
        ),
      );
    }
    // Off ECS, one of many attempts: a recheck write that fails for now is left to the next.
    const offEcs = (id: string) => ({ attempt: { id, taskArn: undefined, of: 10 } });

    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow(
      "the database went away",
    );
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "open"]);

    const posted = await post(h.deps, prepared.runId, offEcs("a2"));
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "fixed"]);
    expect(posted).toMatchObject({ event: "APPROVE" });
    expect(writes.filter((write) => write.startsWith("reply "))).toEqual([
      expect.stringMatching(/^reply 1000: This looks fixed/),
      expect.stringMatching(/^reply 1001: This looks fixed/),
    ]);
  });

  /** Two open findings with inline comments 1000 and 1001, fixed elsewhere: run 2 prepared. */
  async function twoFixed(h: ReturnType<typeof harness>) {
    const second = finding({
      line: 4,
      title: "Total adds the price before the discount",
      evidence: "sum += items[i].price;",
    });
    await run(h, 1, [finding(), second]);
    expect(h.findings.rows.map((row) => row.githubCommentId)).toEqual([1000, 1001]);
    await fixElsewhere();
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    const reason = "src/checkout.ts line 1 adds the item.";
    const verdicts = [
      { id: "F1", confirmed: false, reason },
      { id: "F2", confirmed: false, reason },
    ];
    for (const batch of prepared.batches) {
      h.objects.set(
        runKeys(prepared.runId).batchOutput(batch.index),
        JSON.stringify(
          batch.index === manifest.recheck?.index
            ? { version: 1, index: batch.index, verdicts, transcriptKeys: [] }
            : output({ index: batch.index, findings: [] }),
        ),
      );
    }
    return prepared;
  }
  // Off ECS, one of many attempts: a recheck write that fails for now is left to the next.
  const offEcs = (id: string) => ({ attempt: { id, taskArn: undefined, of: 10 } });
  const replies = (writes: string[]) => writes.filter((write) => write.startsWith("reply "));

  it("writes a reply that failed for now on the retry, and each one once", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    // The first reply goes out, the second fails for now.
    fail.replies.push(undefined, new GitHubError(502, "Bad Gateway", "POST", "/replies"));
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow(
      "weren't written; the retry writes them",
    );
    expect(writes).toEqual([expect.stringMatching(/^reply 1000: /), "resolve PRRT_1"]);

    await post(h.deps, prepared.runId, offEcs("a2"));
    // The first one isn't written again: each write was saved as it went.
    expect(writes).toEqual([
      expect.stringMatching(/^reply 1000: /),
      "resolve PRRT_1",
      expect.stringMatching(/^reply 1001: /),
      "resolve PRRT_2",
    ]);
    // A third attempt finds the step done.
    await post(h.deps, prepared.runId, offEcs("a3"));
    expect(writes).toHaveLength(4);
  });

  it("carries on past a thread that can never take a reply, and posts the review", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    // The first finding's comment is gone: GitHub answers 404, and would every time.
    fail.replies.push(new GitHubError(404, "Not Found", "POST", "/replies"));
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    // Its thread is resolved all the same: the finding is closed.
    expect(writes).toEqual([
      "resolve PRRT_1",
      expect.stringMatching(/^reply 1001: /),
      "resolve PRRT_2",
    ]);
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "fixed"]);
    expect(h.logs).toContain("recheck reply can't be written");
  });

  it("retries only the resolve when the reply went out and the resolve failed", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    fail.resolves.push(new GitHubError(503, "Service Unavailable", "POST", "/graphql"));
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    expect(replies(writes)).toHaveLength(2);
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual(["resolve PRRT_2"]);

    await post(h.deps, prepared.runId, offEcs("a2"));
    // No reply twice: only the resolve that failed.
    expect(replies(writes)).toHaveLength(2);
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual([
      "resolve PRRT_2",
      "resolve PRRT_1",
    ]);
  });

  it("leaves a finding's step open while its thread can't be read, and resolves it on the retry", async () => {
    const { h, writes } = rechecking();
    const prepared = await twoFixed(h);
    // GitHub's threads can't be read during the first attempt, then can.
    let threadsDown = true;
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (installationId) => {
      const client = await github(installationId);
      return {
        ...client,
        threads: {
          reviewThreads: async (target) => {
            if (threadsDown) throw new GitHubError(502, "Bad Gateway", "POST", "/graphql");
            return client.threads.reviewThreads(target);
          },
        },
      };
    };
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual([]);
    expect(replies(writes)).toHaveLength(2);

    threadsDown = false;
    await post(h.deps, prepared.runId, offEcs("a2"));
    expect(replies(writes)).toHaveLength(2);
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual([
      "resolve PRRT_1",
      "resolve PRRT_2",
    ]);
  });

  it("leaves the resolve to the retry when the thread list was read only in part", async () => {
    const { h, writes } = rechecking();
    const prepared = await twoFixed(h);
    // GitHub left a thread out of the list (a null node): one not found may still be there.
    let partial = true;
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (installationId) => {
      const client = await github(installationId);
      return {
        ...client,
        threads: {
          reviewThreads: async (target) => {
            const all = await client.threads.reviewThreads(target);
            if (!partial) return all;
            return Object.assign(
              all.filter((thread) => thread.firstCommentId !== 1001),
              { partial: true as const },
            );
          },
        },
      };
    };
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual(["resolve PRRT_1"]);

    partial = false;
    await post(h.deps, prepared.runId, offEcs("a2"));
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual([
      "resolve PRRT_1",
      "resolve PRRT_2",
    ]);
  });

  it("treats a thread missing from a whole list as gone, with nothing to resolve", async () => {
    const { h, writes } = rechecking();
    const prepared = await twoFixed(h);
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (installationId) => {
      const client = await github(installationId);
      return {
        ...client,
        threads: {
          reviewThreads: async (target) =>
            (await client.threads.reviewThreads(target)).filter(
              (thread) => thread.firstCommentId !== 1001,
            ),
        },
      };
    };
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual(["resolve PRRT_1"]);
  });

  it("closes nothing and replies nowhere when another run's review covers this one", async () => {
    const { h, writes } = rechecking();
    const prepared = await twoFixed(h);
    // Another run's complete review is on the head, and it finished the head: it covers this
    // run, and it's what the PR shows. It still counts the findings.
    const other = "0b6f6d8e-3c1a-4c3e-9a51-6f1f0e0c2a99";
    await h.deps.store.createText(
      runKeys(other).posted,
      JSON.stringify({ attempt: "x", writes: 1, review: true, checkRun: true }),
    );
    h.addReview(headSha, reviewMarker(other, true));
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(posted).toMatchObject({ posted: false, coveredBy: expect.any(String) });
    expect(h.findings.rows.map((row) => row.status)).toEqual(["open", "open"]);
    expect(writes).toEqual([]);
    expect(h.objects.has(runKeys(prepared.runId).rechecks)).toBe(false);
  });

  it("replies to and resolves only the findings this run itself closed", async () => {
    const { h, writes } = rechecking();
    const prepared = await twoFixed(h);
    // Before the post, finding 2 is closed as fixed some other way (a person's reply the judge
    // read): not by this run, so this run doesn't reply on it.
    const second = h.findings.rows[1];
    if (second === undefined) throw new Error("no second finding");
    second.status = "fixed";
    await post(h.deps, prepared.runId, offEcs("a1"));
    expect(replies(writes)).toEqual([expect.stringMatching(/^reply 1000: /)]);
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual(["resolve PRRT_1"]);
  });

  it("retries a reply GitHub refused with a 401 or a 409: only 403, 404 and 422 are for good", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    fail.replies.push(
      new GitHubError(401, "Bad credentials", "POST", "/replies"),
      new GitHubError(409, "Conflict", "POST", "/replies"),
    );
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    expect(replies(writes)).toEqual([]);
    await post(h.deps, prepared.runId, offEcs("a2"));
    expect(replies(writes)).toHaveLength(2);
  });

  it("shows the reviewer our comments again when the recheck doesn't run after all", async () => {
    const { h } = rechecking({
      comments: () => [
        {
          id: 2000,
          inReplyTo: 1000,
          author: "alice",
          body: "REPLY-IN-OUR-THREAD",
          path: "src/total.ts",
          line: 3,
        },
      ],
    });
    await run(h, 1, [finding()]);
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("  let sum = 0;", "  let sum = 0; // total"),
        "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n",
      },
      "fix in the caller, touch the file",
    );
    // A cap that fits the review's batch and nothing more: the recheck is left out.
    const spend = memorySpend({ averageBatchUsd: 1 });
    h.deps.spend = {
      store: spend.store,
      budgets: budgetsSchema.parse({ perPullRequest: { costPerDayUsd: 1 } }),
    };
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    expect(manifest.recheck).toBeUndefined();
    const review = manifest.review.jobs.find((job) => job.files.includes("src/total.ts"));
    expect(review?.prompt).toContain("REPLY-IN-OUR-THREAD");
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(review?.index ?? -1)) ?? "{}",
    ) as { prompt?: string };
    expect(input.prompt).toContain("REPLY-IN-OUR-THREAD");
  });

  it("keeps a finding open whose file was only renamed, and not reviewed under its new name", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    // A pure move of the finding's file, with a fix elsewhere: the move has no change to
    // review, and the recheck reads the finding under a name head doesn't have.
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    headSha = await commit(
      { "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n" },
      "move total, fix in the caller",
    );
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const key = runKeys(prepared.runId).prepared;
    const manifest = readManifest(h.objects.get(key) ?? "");
    // The recheck is told the finding's file by the name it was raised under.
    expect(manifest.recheck?.targets).toMatchObject([{ path: "src/total.ts" }]);
    // The planner leaves the pure move out, as a file with nothing new to review: it's in no
    // batch, and not among the changed files to review.
    manifest.review.files = manifest.review.files.filter((file) => file.path !== "src/sum.ts");
    for (const job of manifest.review.jobs) {
      job.files = job.files.filter((path) => path !== "src/sum.ts");
    }
    const kept = (planned: { file: { path: string } }) => planned.file.path !== "src/sum.ts";
    manifest.review.plan.files = manifest.review.plan.files.filter(kept);
    for (const batch of manifest.review.plan.batches) batch.files = batch.files.filter(kept);
    h.objects.set(key, JSON.stringify(manifest));
    const recheckIndex = manifest.recheck?.index ?? -1;
    for (const batch of prepared.batches) {
      h.objects.set(
        runKeys(prepared.runId).batchOutput(batch.index),
        JSON.stringify(
          batch.index === recheckIndex
            ? {
                version: 1,
                index: batch.index,
                verdicts: [
                  { id: "F1", confirmed: false, reason: "src/checkout.ts line 1 adds the item." },
                ],
                transcriptKeys: [],
              }
            : output({ index: batch.index, findings: [] }),
        ),
      );
    }
    await post(h.deps, prepared.runId);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("closes a renamed finding's fix when the review read the file under its new name", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await git(work, "mv", "src/total.ts", "src/sum.ts");
    headSha = await commit(
      { "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n" },
      "move total, fix in the caller",
    );
    const { manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: false, reason: "src/checkout.ts line 1 adds the item." }],
    );
    expect(manifest.review.jobs.some((job) => job.files.includes("src/sum.ts"))).toBe(true);
    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
  });

  it("closes nothing on a retry once the run no longer counts, before the recheck was saved", async () => {
    const setup: Setup = {};
    const { h, writes } = rechecking(setup);
    const prepared = await twoFixed(h);
    // The first attempt posts the review and dies saving the recheck: nothing is closed yet.
    const createText = h.deps.store.createText.bind(h.deps.store);
    let failing = true;
    h.deps.store.createText = async (key, body) => {
      if (failing && key === runKeys(prepared.runId).rechecks) {
        throw new Error("the store went away");
      }
      return createText(key, body);
    };
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("went away");
    expect(h.objects.has(runKeys(prepared.runId).rechecks)).toBe(false);
    failing = false;
    // The PR moves on before the retry: the review stays recorded, nothing is closed.
    setup.head = "f".repeat(40);
    await post(h.deps, prepared.runId, offEcs("a2"));
    expect(h.findings.rows.map((row) => row.status)).toEqual(["open", "open"]);
    expect(replies(writes)).toEqual([]);
    expect(h.logs).toContain("recheck's fixes not closed: the run no longer counts");
    // What it writes from here counts them open, as the store has them: changes requested.
    const progress = JSON.parse(h.objects.get(runKeys(prepared.runId).posted) ?? "{}") as {
      summaryBody?: string;
      labelTarget?: string;
    };
    expect(progress.summaryBody).toContain("Loop skips the last item");
    expect(h.runs.runs.get(prepared.runId)?.result).toMatchObject({
      statusLabel: progress.labelTarget,
    });
    expect(h.runs.runs.get(prepared.runId)?.result).not.toMatchObject({ statusLabel: "Approved" });
  });

  it("gives up a reply that keeps failing after three attempts, and finishes the post", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    const down = () => new GitHubError(502, "Bad Gateway", "POST", "/replies");
    // The first finding's reply fails every time; the second goes through on the first try.
    fail.replies.push(down(), undefined, down(), down());
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    await expect(post(h.deps, prepared.runId, offEcs("a2"))).rejects.toThrow("retry writes them");
    const posted = await post(h.deps, prepared.runId, offEcs("a3"));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(h.logs).toContain("recheck replies or resolves given up");
    expect(replies(writes)).toEqual([expect.stringMatching(/^reply 1001: /)]);
    // Done: a fourth attempt writes nothing more.
    await post(h.deps, prepared.runId, offEcs("a4"));
    expect(replies(writes)).toHaveLength(1);
  });

  it("doesn't retry a write that failed with something other than GitHub or the network", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    // A reply that came back in a shape we can't read: it would fail the same way again.
    fail.replies.push(new TypeError("Cannot read properties of undefined (reading 'id')"));
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(h.logs).toContain("recheck reply can't be written");
    // Its thread is still resolved; the other finding gets both.
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual([
      "resolve PRRT_1",
      "resolve PRRT_2",
    ]);
  });

  it("still writes the replies on a stale retry once the closes were saved and made", async () => {
    const setup: Setup = {};
    const { h, writes, fail } = rechecking(setup);
    const prepared = await twoFixed(h);
    // The first attempt saves the recheck, closes both findings, then a reply fails for now.
    fail.replies.push(new GitHubError(502, "Bad Gateway", "POST", "/replies"));
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "fixed"]);
    expect(h.objects.has(runKeys(prepared.runId).rechecks)).toBe(true);
    // The PR moves on before the retry: the findings are closed, and still owed their notes.
    setup.head = "f".repeat(40);
    await post(h.deps, prepared.runId, offEcs("a2"));
    // The second went out in the first attempt, the first in the retry: each once.
    expect(replies(writes).map((write) => write.slice(0, 10))).toEqual([
      "reply 1001",
      "reply 1000",
    ]);
    expect(writes.filter((write) => write.startsWith("resolve ")).sort()).toEqual([
      "resolve PRRT_1",
      "resolve PRRT_2",
    ]);
  });

  it("never fails the post step's last attempt over a recheck write", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    const step = (n: number) => ({
      // The step has 4 attempts; post counts which one it's on itself.
      attempt: { id: `a${n}`, taskArn: undefined, of: 4 },
    });
    // Attempts 1 and 2 fail before the recheck's writes: at the first close.
    const close = h.findings.closeFixed?.bind(h.findings);
    let closing = 0;
    h.findings.closeFixed = async (id, sha) => {
      closing += 1;
      if (closing <= 2) throw new Error("the database went away");
      return close?.(id, sha) ?? "theirs";
    };
    await expect(post(h.deps, prepared.runId, step(1))).rejects.toThrow("went away");
    await expect(post(h.deps, prepared.runId, step(2))).rejects.toThrow("went away");
    // Attempt 3 reaches the writes, and a reply fails for now: the step's retry takes it.
    const down = () => new GitHubError(502, "Bad Gateway", "POST", "/replies");
    fail.replies.push(down(), undefined, down());
    await expect(post(h.deps, prepared.runId, step(3))).rejects.toThrow("retry writes them");
    // Attempt 4 is the last: the reply fails again, and the step finishes all the same.
    const posted = await post(h.deps, prepared.runId, step(4));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(h.logs).toContain("recheck replies or resolves given up");
    expect(replies(writes)).toEqual([expect.stringMatching(/^reply 1001: /)]);
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "fixed"]);
  });

  it("finishes a recheck another attempt saved while this one waited for the claim", async () => {
    const setup: Setup = {};
    const { h, writes, fail } = rechecking(setup);
    const prepared = await twoFixed(h);
    // The PR moves on before this attempt starts: it's a retry that no longer counts.
    setup.head = "f".repeat(40);
    const getText = h.deps.store.getText.bind(h.deps.store);
    let interleaved = false;
    h.deps.store.getText = async (key) => {
      if (key !== runKeys(prepared.runId).rechecks || interleaved) return getText(key);
      interleaved = true;
      // This attempt has planned without a saved recheck. Before it holds the claims, an
      // earlier attempt (at the old head) posts the review, saves the recheck, closes both
      // findings, and stops on a reply that failed for now.
      const before = await getText(key);
      delete setup.head;
      fail.replies.push(new GitHubError(502, "Bad Gateway", "POST", "/replies"));
      await expect(post(h.deps, prepared.runId, offEcs("a0"))).rejects.toThrow("retry writes them");
      setup.head = "f".repeat(40);
      return before;
    };
    await post(h.deps, prepared.runId, offEcs("a1"));
    expect(interleaved).toBe(true);
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "fixed"]);
    // The closed findings get their notes: one from the earlier attempt, one from this one.
    expect(
      replies(writes)
        .map((write) => write.slice(0, 10))
        .sort(),
    ).toEqual(["reply 1000", "reply 1001"]);
    expect(writes.filter((write) => write.startsWith("resolve ")).sort()).toEqual([
      "resolve PRRT_1",
      "resolve PRRT_2",
    ]);
    expect(h.logs).not.toContain("recheck's fixes not closed: the run no longer counts");
  });

  it("reads the threads at most once more in an attempt after a failed read", async () => {
    const { h, writes } = rechecking();
    const prepared = await twoFixed(h);
    let reads = 0;
    const github = h.deps.github.bind(h.deps);
    h.deps.github = async (installationId) => {
      const client = await github(installationId);
      return {
        ...client,
        threads: {
          reviewThreads: async () => {
            reads += 1;
            throw new GitHubError(502, "Bad Gateway", "POST", "/graphql");
          },
        },
      };
    };
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    // Once before the decision, once for the resolves: not again for the second finding.
    expect(reads).toBe(2);
    expect(replies(writes)).toHaveLength(2);
  });

  it("treats the step's real last attempt as last when an earlier one was never counted", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    // Attempt n of 4, with the state's retry count; post counts its own starts.
    const step = (n: number) => ({
      attempt: { id: `a${n}`, taskArn: undefined, of: 4, retry: n - 1 },
    });
    // Attempt 1 died before it was counted: it never reached post at all.
    // Attempt 2 fails at the first close, before the recheck's writes.
    const close = h.findings.closeFixed?.bind(h.findings);
    let closing = 0;
    h.findings.closeFixed = async (id, sha) => {
      closing += 1;
      if (closing === 1) throw new Error("the database went away");
      return close?.(id, sha) ?? "theirs";
    };
    await expect(post(h.deps, prepared.runId, step(2))).rejects.toThrow("went away");
    // Attempt 3 reaches the writes, and a reply fails for now.
    const down = () => new GitHubError(502, "Bad Gateway", "POST", "/replies");
    fail.replies.push(down(), undefined, down());
    await expect(post(h.deps, prepared.runId, step(3))).rejects.toThrow("retry writes them");
    // Attempt 4 is the step's last, though its own count says 3: the retry count says 4.
    const posted = await post(h.deps, prepared.runId, step(4));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(h.logs).toContain("recheck replies or resolves given up");
    expect(JSON.parse(h.objects.get(runKeys(prepared.runId).postAttempts) ?? "{}")).toEqual({
      attempts: 3,
    });
    expect(replies(writes)).toEqual([expect.stringMatching(/^reply 1001: /)]);
  });

  it("decides again from the recheck another attempt saved, when it differs from this plan", async () => {
    const setup: Setup = {};
    const { h, writes } = rechecking(setup);
    const prepared = await twoFixed(h);
    // This attempt's plan closes both findings. Another attempt saved one that closes only
    // the first (Z, the second, is in this plan but not in the saved file), while this one
    // waited for the claim.
    const key = runKeys(prepared.runId).rechecks;
    const getText = h.deps.store.getText.bind(h.deps.store);
    let reads = 0;
    h.deps.store.getText = async (name) => {
      if (name === key) {
        reads += 1;
        if (reads === 2) {
          const first = h.findings.rows[0];
          if (first === undefined) throw new Error("no first finding");
          await h.deps.store.createText(
            key,
            JSON.stringify({
              version: 1,
              fixed: [
                {
                  findingId: first.id,
                  githubCommentId: 1000,
                  reason: "src/checkout.ts line 1 adds the item.",
                },
              ],
            }),
          );
        }
      }
      return getText(name);
    };
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(h.logs).toContain("recheck saved by another attempt differs; deciding again from it");
    // Only the saved one is closed, and the decision still counts the other one open.
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "open"]);
    expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(replies(writes).map((write) => write.slice(0, 10))).toEqual(["reply 1000"]);
  });

  it("never fails over a recheck write when the step's attempts aren't known", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    fail.replies.push(new GitHubError(502, "Bad Gateway", "POST", "/replies"));
    // No total of attempts: any of them may be the last, so what's left is only logged.
    const posted = await post(h.deps, prepared.runId, {
      attempt: { id: "a1", taskArn: undefined },
    });
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(h.logs).toContain("recheck replies or resolves given up");
    expect(replies(writes)).toEqual([expect.stringMatching(/^reply 1001: /)]);
  });

  it("still resolves the thread on the last attempt when its reply fails for now", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    fail.replies.push(new GitHubError(502, "Bad Gateway", "POST", "/replies"));
    // The step's only attempt: there's no retry to leave the resolve to.
    const posted = await post(h.deps, prepared.runId, {
      attempt: { id: "a1", taskArn: undefined, number: 1, of: 1 },
    });
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(replies(writes)).toEqual([expect.stringMatching(/^reply 1001: /)]);
    expect(writes.filter((write) => write.startsWith("resolve ")).sort()).toEqual([
      "resolve PRRT_1",
      "resolve PRRT_2",
    ]);
  });

  it("counts a bad attempts file as none, and posts when the count can't be kept", async () => {
    const { h } = rechecking();
    const prepared = await twoFixed(h);
    const key = runKeys(prepared.runId).postAttempts;
    h.objects.set(key, "not json");
    // The store can't keep the count: post goes on, the number unknown.
    const putText = h.deps.store.putText.bind(h.deps.store);
    h.deps.store.putText = async (name, body) => {
      if (name === key) throw new Error("the store went away");
      return putText(name, body);
    };
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(h.logs).toContain("post attempt not counted");
    // Readable again, the bad file counts as none.
    h.deps.store.putText = putText;
    expect(await countAttempt(h.deps, prepared.runId)).toBe(1);
  });

  it("doesn't reply on a finding a person closed after the recheck decided", async () => {
    const { h, writes } = rechecking();
    const prepared = await twoFixed(h);
    // Between the attempt that saved the decision and its retry, a person declines finding 2.
    const close = h.findings.closeFixed?.bind(h.findings);
    let calls = 0;
    h.findings.closeFixed = async (id, sha) => {
      calls += 1;
      if (calls === 2) {
        const row = h.findings.rows.find((candidate) => candidate.id === id);
        if (row !== undefined) row.status = "declined";
        throw new Error("the database went away");
      }
      return close?.(id, sha) ?? "theirs";
    };
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("went away");
    await post(h.deps, prepared.runId, offEcs("a2"));
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "declined"]);
    expect(replies(writes)).toEqual([expect.stringMatching(/^reply 1000: /)]);
  });

  it("treats a GraphQL refusal to resolve as for good, after the review, summary and label", async () => {
    const { h, writes, fail } = rechecking();
    const prepared = await twoFixed(h);
    // GitHub answers the resolve with HTTP 200 and a GraphQL error: the thread was deleted,
    // or the App may not resolve it. Neither ever succeeds; the post goes on.
    fail.resolves.push(
      new GraphQlError([{ type: "NOT_FOUND", message: "Could not resolve to a node" }]),
      new GraphQlError([{ message: "Resource not accessible by integration" }]),
    );
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(posted).toMatchObject({ event: "APPROVE", posted: true });
    expect(replies(writes)).toHaveLength(2);
    expect(writes.filter((write) => write.startsWith("resolve "))).toEqual([]);
    expect(h.logs).toContain("recheck resolve can't be written");
    expect(h.findings.rows.map((row) => row.status)).toEqual(["fixed", "fixed"]);
  });

  it("writes the review, check run, summary and label before a reply that fails for now", async () => {
    const { h, fail } = rechecking();
    const prepared = await twoFixed(h);
    fail.replies.push(new GitHubError(502, "Bad Gateway", "POST", "/replies"));
    await expect(post(h.deps, prepared.runId, offEcs("a1"))).rejects.toThrow("retry writes them");
    const progress = JSON.parse(h.objects.get(runKeys(prepared.runId).posted) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(progress).toMatchObject({ review: true, findings: true, summary: true, label: true });
    expect(progress.rechecks).toBeUndefined();
  });

  it("closes nothing and saves no recheck when the run turns out stale", async () => {
    const setup: Setup = {};
    const { h, writes } = rechecking(setup);
    const prepared = await twoFixed(h);
    // The PR moved on before the post: the run no longer counts.
    setup.head = "f".repeat(40);
    const posted = await post(h.deps, prepared.runId, offEcs("a1"));
    expect(posted).toMatchObject({ posted: false });
    expect(h.findings.rows.map((row) => row.status)).toEqual(["open", "open"]);
    expect(h.objects.has(runKeys(prepared.runId).rechecks)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("keeps a finding open when the review batch for its file failed", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    // The finding's own file changes too, so this run's review was to read it again.
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("  let sum = 0;", "  let sum = 0; // total"),
        "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n",
      },
      "fix in the caller, touch the file",
    );
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    const recheckIndex = manifest.recheck?.index ?? -1;
    expect(manifest.review.jobs.some((job) => job.files.includes("src/total.ts"))).toBe(true);
    // The review batches write nothing (they timed out); the recheck says it's fixed.
    h.objects.set(
      runKeys(prepared.runId).batchOutput(recheckIndex),
      JSON.stringify({
        version: 1,
        index: recheckIndex,
        verdicts: [{ id: "F1", confirmed: false, reason: "src/checkout.ts adds it." }],
        transcriptKeys: [],
      }),
    );
    await post(h.deps, prepared.runId);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("doesn't show the reviewer our comment on a finding it rechecks", async () => {
    const { h } = rechecking({
      comments: () => [
        {
          id: 2000,
          inReplyTo: 1000,
          author: "alice",
          body: "REPLY-IN-OUR-THREAD",
          path: "src/total.ts",
          line: 3,
        },
        { id: 7, author: "bob", body: "SOME-OTHER-NOTE", path: "src/total.ts", line: 4 },
      ],
    });
    await run(h, 1, [finding()]);
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace("  let sum = 0;", "  let sum = 0; // total"),
        "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n",
      },
      "fix in the caller, touch the file",
    );
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    expect(manifest.recheck?.targets.map((target) => target.githubCommentId)).toEqual([1000]);
    const review = manifest.review.jobs.find((job) => job.files.includes("src/total.ts"));
    expect(review?.prompt).toContain("SOME-OTHER-NOTE");
    expect(review?.prompt).not.toContain("REPLY-IN-OUR-THREAD");
  });

  it("posts nothing new when a cap stops every review batch, though the recheck would fit", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    // The head's last run was stopped by this cap already. The probe sees nothing spent (the
    // ledger moved on since), so only the plan finds the review doesn't fit; the recheck would.
    const spend = memorySpend({ averageBatchUsd: 10 }, "pr_cost");
    spend.store.snapshot = async () => ({
      prDayRuns: 0,
      prDayUsd: 0,
      repoMonthUsd: 0,
      monthUsd: 0,
      averageBatchUsd: 1,
    });
    h.deps.spend = {
      store: spend.store,
      budgets: budgetsSchema.parse({ perPullRequest: { costPerDayUsd: 5 } }),
    };
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    expect(prepared).toMatchObject({ superseded: true, batches: [] });
  });

  it("runs no recheck when a cap leaves out a review batch", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    // A review batch costs 10 by the deployment's average; the recheck far less. A cap of 5
    // fits the recheck, not the review: then nothing re-reviewed the file, so no recheck.
    const spend = memorySpend({ averageBatchUsd: 10 });
    h.deps.spend = {
      store: spend.store,
      budgets: budgetsSchema.parse({ perPullRequest: { costPerDayUsd: 5 } }),
    };
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    expect(manifest.spendCap?.batches.length).toBeGreaterThan(0);
    expect(manifest.recheck).toBeUndefined();
    expect(prepared.batches).toEqual([]);
  });

  it("keeps a finding open when its file changed but no batch reviewed it", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const key = runKeys(prepared.runId).prepared;
    const manifest = readManifest(h.objects.get(key) ?? "");
    const recheckIndex = manifest.recheck?.index ?? -1;
    // The finding's file is among the review's changed files, but the planner skipped it (too
    // large, say): it's in no batch, so nothing read it again.
    const changed = manifest.review.files[0];
    if (changed === undefined) throw new Error("no changed file");
    manifest.review.files.push({ ...changed, path: "src/total.ts" });
    h.objects.set(key, JSON.stringify(manifest));
    for (const job of manifest.review.jobs) {
      h.objects.set(
        runKeys(prepared.runId).batchOutput(job.index),
        JSON.stringify(output({ index: job.index, findings: [] })),
      );
    }
    h.objects.set(
      runKeys(prepared.runId).batchOutput(recheckIndex),
      JSON.stringify({
        version: 1,
        index: recheckIndex,
        verdicts: [{ id: "F1", confirmed: false, reason: "src/checkout.ts adds it." }],
        transcriptKeys: [],
      }),
    );
    await post(h.deps, prepared.runId);
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("drops the recheck, never a review batch, when a cap fits only the review", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    const spend = memorySpend({ averageBatchUsd: 1 });
    h.deps.spend = {
      store: spend.store,
      budgets: budgetsSchema.parse({ perPullRequest: { costPerDayUsd: 1 } }),
    };
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    // The review's one batch runs; the recheck was the batch the cap left out.
    expect(manifest.review.jobs.filter((job) => job.prompt !== undefined)).toHaveLength(1);
    expect(prepared.batches).toEqual([{ index: manifest.review.jobs[0]?.index ?? -1 }]);
    expect(manifest.recheck).toBeUndefined();
    // Only the recheck was left out: the review isn't a capped one.
    expect(manifest.spendCap).toBeUndefined();
    expect(spend.capped.size).toBe(0);
  });

  it("keeps a finding this run's review raised again, whatever the recheck says", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("  let sum = 0;", "  let sum = 0; // total") },
      "touch the file",
    );
    const { posted } = await run(
      h,
      2,
      [finding()],
      [{ id: "F1", confirmed: false, reason: "src/total.ts no longer has the bug." }],
    );
    expect(h.findings.rows.map((row) => row.status)).toEqual(["open"]);
    expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
  });

  it("checks at most ten findings in one batch, blocking ones first", async () => {
    const { h } = rechecking();
    const many = [1, 2, 3, 4, 5, 6].flatMap((line) => [
      finding({ line, severity: "should_fix", title: `Should fix number ${line} here` }),
      finding({ line, title: `Blocking problem number ${line} here` }),
    ]);
    await run(h, 1, many);
    expect(h.findings.rows.filter((row) => row.status === "open")).toHaveLength(12);
    await fixElsewhere();

    const { manifest } = await run(h, 2, [], []);

    const targets = manifest.recheck?.targets ?? [];
    expect(targets).toHaveLength(10);
    expect(targets.slice(0, 6).every((target) => target.severity === "blocking")).toBe(true);
    expect(targets.map((target) => target.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `F${i + 1}`),
    );
  });

  const FULL_REVIEW = { ...JOB, requested: "full_review" as const };

  it("rechecks on a full review too: closes a finding fixed in another file and approves", async () => {
    const { h, writes } = rechecking();
    const { manifest: firstManifest, posted: first } = await run(h, 1, [finding()]);
    expect(first).toMatchObject({ event: "REQUEST_CHANGES" });
    const raisedAt = headSha;
    expect(firstManifest.recheck).toBeUndefined();
    await fixElsewhere();

    const { prepared, manifest, posted } = await run(
      h,
      2,
      [],
      [
        {
          id: "F1",
          confirmed: false,
          reason: "src/checkout.ts line 1 adds the item the loop skips.",
        },
      ],
      FULL_REVIEW,
    );

    // Picked from every open finding, measured from the commit it was raised at.
    expect(manifest.recheck).toMatchObject({
      mode: "full",
      sinceSha: raisedAt,
      changed: ["src/checkout.ts"],
      targets: [{ id: "F1", findingId: "f0", severity: "blocking", githubCommentId: 1000 }],
    });
    // The reviewer wasn't shown our comment on it, as on an incremental review.
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(manifest.recheck?.index ?? -1)) ?? "{}",
    ) as Record<string, unknown>;
    expect(input).toMatchObject({ role: "recheck", tier: "fast" });
    expect(input.prompt).toContain("+++ b/src/checkout.ts");
    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
    expect(posted).toMatchObject({ event: "APPROVE" });
    expect(writes[0]).toMatch(/^reply 1000: This looks fixed at [0-9a-f]{7}/);
    expect(writes[1]).toBe("resolve PRRT_1");
  });

  it("keeps a finding a full review's recheck still finds open, and logs why", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    const { posted } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: true, reason: "src/total.ts line 3 still stops one short." }],
      FULL_REVIEW,
    );
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(posted).toMatchObject({ event: "REQUEST_CHANGES" });
    expect(writes).toEqual([]);
    expect(h.logs).toContain("full review left a carried blocking finding open");
  });

  it("measures a full review's recheck from the merge base when the raised commit is gone", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    // A force-push: the branch starts again from the base, so the commit the finding was raised
    // at isn't in head's history any more (GitHub still serves it).
    await git(work, "reset", "--quiet", "--hard", baseSha);
    headSha = await commit(
      {
        "src/total.ts": `${HEAD_TOTAL}// rebased\n`,
        "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n",
      },
      "rebased",
    );
    const { prepared, manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: true, reason: "Still there." }],
      FULL_REVIEW,
    );
    expect(manifest.recheck).toMatchObject({ mode: "full", sinceSha: baseSha });
    expect(manifest.recheck?.changed).toEqual(
      expect.arrayContaining(["src/total.ts", "src/checkout.ts"]),
    );
    // The prompt says the diff is from the merge base, and that the finding's commit is gone.
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(manifest.recheck?.index ?? -1)) ?? "{}",
    ) as Record<string, unknown>;
    expect(input.prompt).toContain("# What the pull request changes, from its merge base");
    expect(input.prompt).toContain("is no longer in the branch's history");
  });

  it("leaves out, and never closes, a finding whose raised commit can't be read", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    // Its commit is gone altogether: its line can't be followed, so prepare leaves it out.
    for (const row of h.findings.rows) row.raisedAtSha = "0".repeat(40);
    const fixed = [{ id: "F1", confirmed: false, reason: "src/checkout.ts line 1 fixes it." }];
    const { manifest } = await run(h, 2, [], fixed, FULL_REVIEW);
    expect(manifest.recheck).toBeUndefined();
    // Post can't place it either: outdated, as before, never fixed, its thread left alone.
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(writes).toEqual([]);
  });

  it("doesn't close through the outdated path a finding prepare didn't mark outdated", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    // Prepare follows its line and sends it as open; by the post step its commit is gone, so
    // post can't place it and takes it as outdated. Without prepare's mark, it isn't closed.
    const prepared = await prepare(h.deps, JOB, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    expect(manifest.recheck?.targets).toMatchObject([{ findingId: "f0" }]);
    expect(manifest.recheck?.targets[0]?.outdated).toBeUndefined();
    for (const batch of prepared.batches) {
      const key = runKeys(prepared.runId).batchOutput(batch.index);
      h.objects.set(
        key,
        JSON.stringify(
          batch.index === manifest.recheck?.index
            ? {
                version: 1,
                index: batch.index,
                verdicts: [{ id: "F1", confirmed: false, reason: "src/checkout.ts fixes it." }],
                transcriptKeys: [],
              }
            : output({ index: batch.index, findings: [] }),
        ),
      );
    }
    for (const row of h.findings.rows) row.raisedAtSha = "0".repeat(40);
    await post(h.deps, prepared.runId);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(writes).toEqual([]);
  });

  it("doesn't recheck on a full review what nothing changed since it was raised", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    const fixed = [{ id: "F1", confirmed: false, reason: "src/total.ts line 3 is fine." }];
    // Again at the head it was raised at: nothing changed, nothing could have fixed it.
    const { manifest: same } = await run(h, 2, [], fixed, FULL_REVIEW);
    expect(same.recheck).toBeUndefined();
    // A change only in another folder: neither its file nor a related one changed.
    headSha = await commit({ "docs/notes.md": "Notes.\n" }, "docs");
    const { manifest: elsewhere } = await run(h, 3, [], fixed, FULL_REVIEW);
    expect(elsewhere.recheck).toBeUndefined();
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
    expect(writes).toEqual([]);
  });

  it("names a protected finding's related files from when it was raised, on a full review", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    // A policy lands next to the file, then a protected finding is raised on a later commit.
    await commit({ "src/policy.ts": "export const allowed = () => true;\n" }, "policy");
    headSha = await commit(
      { "src/guard.ts": "export const guard = (user: User) => user.id !== '';\n" },
      "guard",
    );
    const authz = finding({
      rule_category: "authz",
      path: "src/guard.ts",
      line: 1,
      evidence: "export const guard = (user: User) => user.id !== '';",
      title: "Any signed-in user passes the guard",
    });
    await run(h, 2, [authz], [{ id: "F1", confirmed: true, reason: "Still there." }]);
    expect(h.findings.rows.map((row) => row.ruleCategory)).toEqual(["correctness", "authz"]);
    await fixElsewhere();
    const { manifest } = await run(
      h,
      3,
      [],
      [
        { id: "F1", confirmed: true, reason: "Still there." },
        { id: "F2", confirmed: false, reason: "src/policy.ts line 1 checks the caller's role." },
      ],
      FULL_REVIEW,
    );
    const authzEntry = manifest.recheck?.targets.find((entry) => entry.ruleCategory === "authz");
    // Measured from the older finding's commit, but the policy came before this one was raised:
    // it can't be this one's fix.
    expect(manifest.recheck?.changed).toContain("src/policy.ts");
    expect(authzEntry?.related).toEqual(["src/checkout.ts"]);
    expect(h.findings.rows.map((row) => row.status)).toEqual(["open", "open"]);
  });

  it("drops a full review's recheck when a spend cap leaves out a review batch", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    // A cap that fits the cheap recheck but not the review's batch.
    const spend = memorySpend({ averageBatchUsd: 1 });
    h.deps.spend = {
      store: spend.store,
      budgets: budgetsSchema.parse({ perPullRequest: { costPerDayUsd: 0.5 } }),
    };
    const prepared = await prepare(h.deps, FULL_REVIEW, exec(2), SETTINGS);
    const manifest = readManifest(h.objects.get(runKeys(prepared.runId).prepared) ?? "");
    expect(manifest.recheck).toBeUndefined();
  });

  it("rechecks as a full review does when a review meant to be incremental comes out full", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    // Nothing on record as reviewed: the review reads every file again.
    h.runs.reviewedFiles = async () => [];
    const { manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: true, reason: "Still there." }],
    );
    expect(manifest.review.kind).toBe("full");
    expect(manifest.recheck).toMatchObject({ mode: "full", targets: [{ findingId: "f0" }] });
  });

  // NIC-1124: a finding whose cited line is edited goes outdated; the recheck resolves its
  // thread when the edit fixed it.
  /** Someone commits the suggestion: the cited loop bound is edited to the fix. */
  const commitSuggestion = async () => {
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("i < items.length - 1", "i <= items.length - 1") },
      "apply suggestion",
    );
  };

  it("closes a finding whose cited line was edited to the fix, replies and resolves", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    await commitSuggestion();
    const { prepared, manifest, posted } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: false, reason: "src/total.ts line 3 now counts every item." }],
    );
    expect(manifest.recheck).toMatchObject({
      changed: ["src/total.ts"],
      targets: [{ id: "F1", findingId: "f0", outdated: true, githubCommentId: 1000 }],
    });
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(manifest.recheck?.index ?? -1)) ?? "{}",
    ) as Record<string, unknown>;
    expect(input.prompt).toContain("The cited line has been edited or deleted since.");
    expect(input.prompt).toContain("+++ b/src/total.ts");
    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
    expect(posted).toMatchObject({ event: "APPROVE" });
    expect(writes[0]).toMatch(/^reply 1000: This looks fixed at [0-9a-f]{7}/);
    expect(writes[1]).toBe("resolve PRRT_1");
  });

  it("leaves a finding whose cited line was edited without the fix outdated and unresolved", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL.replace("i++", "i += 1") },
      "reword the loop",
    );
    const { manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: true, reason: "The bound still stops one short." }],
    );
    expect(manifest.recheck).toMatchObject({ targets: [{ findingId: "f0", outdated: true }] });
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(writes).toEqual([]);

    // Unsure on a later run (no verdict): still outdated, still unresolved.
    headSha = await commit({ "src/total.ts": HEAD_TOTAL.replace("i++", "i += 2") }, "again");
    const { manifest: later } = await run(h, 3, [], []);
    expect(later.recheck).toMatchObject({ targets: [{ findingId: "f0", outdated: true }] });
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    expect(writes).toEqual([]);
  });

  it("closes a finding outdated in an earlier run once a later commit fixes it", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    headSha = await commit({ "src/total.ts": HEAD_TOTAL.replace("i++", "i += 1") }, "reword");
    await run(h, 2, [], [{ id: "F1", confirmed: true, reason: "Still one short." }]);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    headSha = await commit(
      {
        "src/total.ts": HEAD_TOTAL.replace(
          "i < items.length - 1; i++",
          "i <= items.length - 1; i += 1",
        ),
      },
      "fix the bound",
    );
    const { manifest } = await run(
      h,
      3,
      [],
      [{ id: "F1", confirmed: false, reason: "src/total.ts line 3 now counts every item." }],
    );
    expect(manifest.recheck).toMatchObject({ targets: [{ findingId: "f0", outdated: true }] });
    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
    expect(writes).toEqual([
      expect.stringMatching(/^reply 1000: This looks fixed at/),
      "resolve PRRT_1",
    ]);
  });

  it("rechecks one whose cited line is back as open, without the edited-line note", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    headSha = await commit({ "src/total.ts": HEAD_TOTAL.replace("i++", "i += 1") }, "reword");
    await run(h, 2, [], [{ id: "F1", confirmed: true, reason: "Still one short." }]);
    expect(h.findings.rows).toMatchObject([{ status: "outdated" }]);
    // Reverted: the cited line is back, and something next to it changes.
    headSha = await commit(
      { "src/total.ts": HEAD_TOTAL, "src/checkout.ts": "export const x = 1;\n" },
      "revert",
    );
    const { prepared, manifest } = await run(
      h,
      3,
      [],
      [{ id: "F1", confirmed: true, reason: "Still one short." }],
    );
    expect(manifest.recheck?.targets).toMatchObject([{ findingId: "f0" }]);
    expect(manifest.recheck?.targets[0]?.outdated).toBeUndefined();
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(manifest.recheck?.index ?? -1)) ?? "{}",
    ) as Record<string, unknown>;
    expect(input.prompt).not.toContain("The cited line has been edited or deleted since.");
    expect(h.findings.rows).toMatchObject([{ status: "open" }]);
  });

  it("resolves an outdated nit that's fixed, on a full review too", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding({ severity: "nit", title: "Loop bound reads oddly" })]);
    await commitSuggestion();
    const { manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: false, reason: "src/total.ts line 3 loops over every item." }],
      FULL_REVIEW,
    );
    expect(manifest.recheck).toMatchObject({
      mode: "full",
      targets: [{ findingId: "f0", severity: "nit", outdated: true }],
    });
    expect(h.findings.rows).toMatchObject([{ status: "fixed" }]);
    expect(writes).toEqual([
      expect.stringMatching(/^reply 1000: This looks fixed at/),
      "resolve PRRT_1",
    ]);
  });

  it("doesn't recheck a finding on a file the PR no longer changes", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [finding()]);
    // The base takes the PR's change and the PR merges it: the PR no longer changes the file,
    // though the cited line is still there. Nothing reviews the file, so nothing could close it.
    await git(work, "checkout", "--quiet", "main");
    baseSha = await commit({ "src/total.ts": HEAD_TOTAL }, "take the fix on main");
    await git(work, "checkout", "--quiet", "feature");
    await git(work, "merge", "--quiet", "--no-edit", "main");
    headSha = await commit(
      { "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n" },
      "caller",
    );
    const { manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: false, reason: "src/checkout.ts line 1 fixes it." }],
    );
    expect(manifest.review.files.map((file) => file.path)).not.toContain("src/total.ts");
    expect(manifest.recheck).toBeUndefined();
    expect(h.findings.rows[0]?.status).not.toBe("fixed");
    expect(writes).toEqual([]);
  });

  it("keeps a protected finding open on a full review after a force-push dropped its commit", async () => {
    const { h, writes } = rechecking();
    await run(h, 1, [
      finding({ rule_category: "authz", title: "Total is computed for any caller" }),
    ]);
    // Rebased onto the base again: the commit it was raised at isn't in head's history, so its
    // diff to head would hold whatever the rebase brought in.
    await git(work, "reset", "--quiet", "--hard", baseSha);
    headSha = await commit(
      {
        "src/total.ts": `${HEAD_TOTAL}// rebased\n`,
        "src/checkout.ts": "export const guarded = (user: User) => user.admin;\n",
      },
      "rebased",
    );
    const { manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: false, reason: "src/checkout.ts line 1 checks the caller." }],
      FULL_REVIEW,
    );
    expect(manifest.recheck).toMatchObject({ mode: "full", targets: [{ related: [] }] });
    expect(h.logs).toContain(
      "protected finding can't close on this run: its commit isn't in head's history",
    );
    expect(h.findings.rows[0]?.status).not.toBe("fixed");
    expect(writes).toEqual([]);
  });

  it("keeps a full review's fix in the recheck's diff ahead of many unrelated files", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    // About 100 unrelated files that sort ahead of the fix, far more diff than the budget.
    const filler = "export const filler = [\n" + '  "0123456789abcdef",\n'.repeat(60) + "];\n";
    const unrelated = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`lib/a${String(i).padStart(3, "0")}.ts`, filler]),
    );
    headSha = await commit(
      {
        ...unrelated,
        "src/checkout.ts": "export const items = (all: Item[]) => [...all, { price: 0 }];\n",
      },
      "a big change and the fix",
    );
    const { prepared, manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: true, reason: "Still there." }],
      FULL_REVIEW,
    );
    expect(manifest.recheck?.changed[0]).toMatch(/^lib\//);
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(manifest.recheck?.index ?? -1)) ?? "{}",
    ) as Record<string, unknown>;
    expect(input.prompt).toContain("+++ b/src/checkout.ts");
    expect(input.prompt).toContain("the rest of the diff is left out");
  });

  it("tells a full review's recheck that a fix must come after each finding's commit", async () => {
    const { h } = rechecking();
    await run(h, 1, [finding()]);
    await fixElsewhere();
    const { prepared, manifest } = await run(
      h,
      2,
      [],
      [{ id: "F1", confirmed: true, reason: "Still there." }],
      FULL_REVIEW,
    );
    const input = JSON.parse(
      h.objects.get(runKeys(prepared.runId).batchInput(manifest.recheck?.index ?? -1)) ?? "{}",
    ) as Record<string, unknown>;
    expect(input.prompt).toContain("only a change made after that commit can be its fix");
  });

  it("doesn't recheck without the store's support", async () => {
    const plain = harness({ commentIds: true });
    await run(plain, 1, [finding()]);
    headSha = await commit({ "src/checkout.ts": "export const later = 1;\n" }, "later");
    const { manifest } = await run(plain, 2);
    expect(manifest.recheck).toBeUndefined();
  });
});
