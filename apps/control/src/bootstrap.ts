import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BOOTSTRAP_COMMENT_ID, type BootstrapCandidate } from "@lgtmoose/core";
import type { BootstrapSource } from "@lgtmoose/db";
import {
  checkBootstrapProposal,
  learningKey,
  redactSensitive,
  storeBootstrapLearning,
  type BootstrapProposal,
  type LearningStore,
} from "@lgtmoose/learnings";
import {
  batchInputSchema,
  batchOutputSchema,
  runKeys,
  scanText,
  type BatchInput,
} from "@lgtmoose/pipeline";
import { BOOTSTRAPPER_TIER, buildBootstrapPrompt } from "@lgtmoose/roles";
import { z } from "zod";
import type { BootstrapStore } from "./bootstrap-store.js";
import type { ControlDeps } from "./ports.js";
import type { PrepareOutput, PrepareSettings } from "./prepare.js";
import type { Permission } from "./thread-policy.js";

/**
 * Learning from a repository's review history (NIC-1080). Someone asks on the dashboard, or with
 * `lgtmoose learnings bootstrap`; the reconciler starts a run of the review workflow for it,
 * with a bootstrap job instead of a PR:
 *
 * - **Prepare** (the control task, with the App's installation token) reads the merged PRs'
 *   review comments, newest first, keeps those by people with write access, drops bots,
 *   LGTMoose's own comments and any the prompt-injection detector flags, redacts them, and writes
 *   them as fast-tier bootstrapper batches, as many as the cost cap allows. It also reads the
 *   repository's lint configs and CODEOWNERS, which become hints without a model.
 * - **The sandbox** runs the bootstrapper on each batch with no GitHub token and no checkout.
 *   Its output is `candidates`: proposals, nothing that acts.
 * - **Post** checks each candidate (at least two distinct comments of its batch, the detector,
 *   the learnings write policy), dedupes it against the repository's learnings, and stores it
 *   as pending with its sources. Nothing becomes active without a person approving it.
 *
 * A run can be repeated: post dedupes, so a retried or second bootstrap doesn't store a learning
 * twice, and `resume` reads the PRs below the oldest one an earlier bootstrap read.
 */

export const BOOTSTRAP_DEFAULTS = {
  /** Merged PRs read, newest first. */
  maxPrs: 200,
  /** The most a request may ask for. */
  maxPrsLimit: 1000,
  /** The estimated model cost cap, in USD, unless the deployment sets `learnings.bootstrapMaxCostUsd`. */
  maxCostUsd: 5,
  /**
   * What a request without its own cap records: more than any deployment's cap, which the
   * prepare step applies (the lower of the two).
   */
  maxCostUsdLimit: 1000,
} as const;

/**
 * What one bootstrapper batch is estimated to cost before it runs: a fast-tier call on about
 * 30,000 characters of comments, generously. The cap keeps the run to `maxCostUsd / this`
 * batches; post records what the batches reported.
 */
export const BOOTSTRAP_BATCH_ESTIMATE_USD = 0.05;

/** The longest a bootstrapper batch may take. */
export const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;

/** Comments per batch, and their characters, so a prompt stays small. */
const COMMENTS_PER_BATCH = 60;
const CHARS_PER_BATCH = 30_000;
/** A comment's text kept in the prompt; and shorter than this, it says too little to learn from. */
const MAX_COMMENT_CHARS = 1_500;
const MIN_COMMENT_CHARS = 20;
/** The most learnings one bootstrap stores, so a person can still read them all. */
export const MAX_PROPOSED = 50;

/** A bootstrap job, the execution input the reconciler starts it with. */
export const bootstrapJobSchema = z.object({
  bootstrapId: z.uuid(),
  installationId: z.number().int().positive(),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "use owner/name"),
});

export type BootstrapJob = z.infer<typeof bootstrapJobSchema>;

/** Whether an execution's input is a bootstrap job rather than a review job. */
export function isBootstrapInput(input: unknown): boolean {
  return typeof input === "object" && input !== null && "bootstrapId" in input;
}

/** A review comment on a merged PR, as GitHub has it. Its body is untrusted. */
export interface HistoryComment {
  id: number;
  pr: number;
  author: string;
  authorIsBot: boolean;
  body: string;
  url: string;
  /** The file, for an inline comment. */
  path?: string;
}

/** GitHub for one installation, as a bootstrap reads it. */
export interface BootstrapGitHub {
  /** Merged PR numbers, newest first, below `before` when it's set, at most `limit`. */
  mergedPulls(repo: string, options: { before?: number; limit: number }): Promise<number[]>;
  /** A PR's inline review comments and submitted reviews' bodies. */
  comments(repo: string, pr: number): Promise<HistoryComment[]>;
  /** A login's permission on the repository; `none` when unread. */
  permission(repo: string, login: string): Promise<Permission>;
  /** A file on the default branch, or undefined. */
  file(repo: string, path: string): Promise<string | undefined>;
}

/** What a bootstrap needs on top of the control task's dependencies. */
export interface BootstrapDeps {
  store: BootstrapStore;
  github(installationId: number): Promise<BootstrapGitHub>;
  learnings: Pick<LearningStore, "insert" | "list">;
  /** The deployment's cap per bootstrap (`learnings.bootstrapMaxCostUsd`). */
  maxCostUsd: number;
}

const WRITE: ReadonlySet<Permission> = new Set(["admin", "maintain", "write"]);

/** A comment as it goes in the prompt: redacted, quotes and markup removed, clipped. */
export function cleanComment(body: string): string {
  const text = body
    // Our own markers, and any HTML comment.
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    // What it quotes is someone else's text.
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
  const { text: redacted } = redactSensitive(text);
  return redacted.length > MAX_COMMENT_CHARS ? `${redacted.slice(0, MAX_COMMENT_CHARS - 1)}…` : redacted;
}

/** A command to a bot (`@lgtmoose learn: …`, `/review`): not a review remark. */
function isCommand(text: string): boolean {
  return /^\s*[@/][A-Za-z0-9-]+(\[bot\])?\b/.test(text);
}

/** A comment kept for the prompt. */
export interface KeptComment {
  pr: number;
  commentId: number;
  url: string;
  path?: string;
  text: string;
}

/**
 * The comments a bootstrap learns from: by people with write access on the repository now (its
 * history's authors' access then isn't recorded; their access now is close), not bots or
 * LGTMoose, long enough to say something, not commands, and not flagged by the
 * prompt-injection detector (`held` counts those).
 */
export async function selectComments(
  comments: readonly HistoryComment[],
  permission: (login: string) => Promise<Permission>,
): Promise<{ kept: KeptComment[]; held: number }> {
  const kept: KeptComment[] = [];
  let held = 0;
  for (const comment of comments) {
    if (comment.authorIsBot || comment.body.includes("<!-- lgtmoose:")) continue;
    const text = cleanComment(comment.body);
    if (text.length < MIN_COMMENT_CHARS || isCommand(text)) continue;
    if (!WRITE.has(await permission(comment.author))) continue;
    if (scanText(text, { markdown: true }).length > 0) {
      held += 1;
      continue;
    }
    kept.push({
      pr: comment.pr,
      commentId: comment.id,
      url: comment.url,
      ...(comment.path === undefined ? {} : { path: comment.path }),
      text,
    });
  }
  return { kept, held };
}

/** One bootstrapper batch: its comments, with the IDs the prompt gives them. */
export interface PlannedBatch {
  comments: (KeptComment & { id: string })[];
}

/**
 * Packs the PRs' comments, newest PR first, into batches of at most `COMMENTS_PER_BATCH`
 * comments and `CHARS_PER_BATCH` characters, at most `maxBatches` of them. A PR is taken whole
 * or not at all, so `oldestPr` is where a resume carries on. `capped` when PRs were left out.
 */
export function planBatches(
  prs: readonly { pr: number; comments: readonly KeptComment[] }[],
  maxBatches: number,
): { batches: PlannedBatch[]; prsRead: number; oldestPr: number | undefined; capped: boolean } {
  const batches: PlannedBatch[] = [];
  // The open batch's size: a comment that doesn't fit starts the next batch.
  let count = 0;
  let chars = 0;
  const fits = (length: number) =>
    batches.length > 0 && count < COMMENTS_PER_BATCH && chars + length <= CHARS_PER_BATCH;
  let prsRead = 0;
  let oldestPr: number | undefined;
  for (const { pr, comments } of prs) {
    // How many batches there'd be with this PR's comments.
    let total = batches.length;
    let simCount = count;
    let simChars = chars;
    for (const { text } of comments) {
      if (total === 0 || simCount >= COMMENTS_PER_BATCH || simChars + text.length > CHARS_PER_BATCH) {
        total += 1;
        simCount = 0;
        simChars = 0;
      }
      simCount += 1;
      simChars += text.length;
    }
    if (total > maxBatches) return { batches, prsRead, oldestPr, capped: true };
    for (const comment of comments) {
      if (!fits(comment.text.length)) {
        batches.push({ comments: [] });
        count = 0;
        chars = 0;
      }
      const current = batches[batches.length - 1] as PlannedBatch;
      current.comments.push({ ...comment, id: `c${current.comments.length + 1}` });
      count += 1;
      chars += comment.text.length;
    }
    prsRead += 1;
    oldestPr = pr;
  }
  return { batches, prsRead, oldestPr, capped: false };
}

/** Lint and format tools whose config tells the reviewer what's already enforced. */
const TOOLS: readonly { name: string; files: readonly string[]; what: string; category: string }[] = [
  {
    name: "ESLint",
    files: [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yml",
      ".eslintrc.yaml",
    ],
    what: "lint rules",
    category: "style",
  },
  { name: "Biome", files: ["biome.json", "biome.jsonc"], what: "lint and formatting rules", category: "style" },
  {
    name: "Prettier",
    files: [".prettierrc", ".prettierrc.json", ".prettierrc.yaml", ".prettierrc.yml", "prettier.config.js", "prettier.config.mjs"],
    what: "formatting",
    category: "style",
  },
  { name: "Ruff", files: ["ruff.toml", ".ruff.toml"], what: "lint and formatting rules", category: "style" },
  {
    name: "golangci-lint",
    files: [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"],
    what: "lint rules",
    category: "style",
  },
  { name: "RuboCop", files: [".rubocop.yml"], what: "lint and style rules", category: "style" },
];

/** Files a bootstrap reads for hints. */
export const HINT_FILES: readonly string[] = [
  ...TOOLS.flatMap((tool) => tool.files),
  "pyproject.toml",
  "CODEOWNERS",
  ".github/CODEOWNERS",
  "docs/CODEOWNERS",
];

/** A learning from a file, with no model involved. */
export interface Hint {
  proposal: BootstrapProposal;
  file: string;
}

/** A CODEOWNERS path pattern safe to repeat in a learning: plain path characters only. */
const OWNED_PATTERN = /^[A-Za-z0-9_./*-]{1,100}$/;

/**
 * Hints from the repository's files: a lint or format tool's config means the reviewer needn't
 * repeat what it enforces (a `scoping` learning on style), and CODEOWNERS names paths another
 * team owns (a `convention`). No owner's handle is copied into a learning.
 */
export function fileHints(files: ReadonlyMap<string, string | undefined>): Hint[] {
  const hints: Hint[] = [];
  for (const tool of TOOLS) {
    const file = tool.files.find((name) => files.get(name) !== undefined);
    if (file === undefined) continue;
    hints.push({
      file,
      proposal: {
        kind: "scoping",
        category: tool.category,
        text: `${tool.name} runs on this repository (${file}): don't raise findings about ${tool.what} it already enforces.`,
      },
    });
  }
  const pyproject = files.get("pyproject.toml");
  if (pyproject !== undefined && /^\s*\[tool\.ruff/m.test(pyproject) && !hints.some((hint) => hint.proposal.text.startsWith("Ruff"))) {
    hints.push({
      file: "pyproject.toml",
      proposal: {
        kind: "scoping",
        category: "style",
        text: "Ruff runs on this repository (pyproject.toml): don't raise findings about lint and formatting rules it already enforces.",
      },
    });
  }
  const codeowners = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"].find(
    (name) => files.get(name) !== undefined,
  );
  if (codeowners !== undefined) {
    const patterns = [
      ...new Set(
        (files.get(codeowners) ?? "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#"))
          .map((line) => line.split(/\s+/)[0] ?? "")
          .filter((pattern) => pattern !== "*" && OWNED_PATTERN.test(pattern)),
      ),
    ].slice(0, 8);
    if (patterns.length > 0) {
      hints.push({
        file: codeowners,
        proposal: {
          kind: "convention",
          category: "ownership",
          text: `These paths have their own code owners (${codeowners}): ${patterns.join(", ")}. Say so when a PR changes them alongside unrelated code.`,
        },
      });
    }
  }
  return hints;
}

/** The bootstrap's plan, kept for its post step: comment references, never their text. */
const manifestSchema = z.object({
  version: z.literal(1),
  kind: z.literal("bootstrap"),
  bootstrapId: z.uuid(),
  repo: z.string(),
  batches: z.array(
    z.object({
      index: z.number().int().min(0),
      comments: z.array(
        z.object({
          id: z.string().regex(BOOTSTRAP_COMMENT_ID),
          pr: z.number().int().positive(),
          commentId: z.number().int().positive(),
          url: z.string(),
          path: z.string().optional(),
        }),
      ),
    }),
  ),
  hints: z.array(
    z.object({
      file: z.string(),
      proposal: z.object({
        kind: z.enum(["accepted_pattern", "correction", "convention", "scoping"]),
        text: z.string(),
        category: z.string().optional(),
        pathGlob: z.string().optional(),
      }),
    }),
  ),
});

type Manifest = z.infer<typeof manifestSchema>;

/** Runs `work` on each of `items`, at most `limit` at once, keeping their order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const at = next;
        next += 1;
        results[at] = await work(items[at] as T);
      }
    }),
  );
  return results;
}

/**
 * The prepare step of a bootstrap: reads the history, plans the batches within the cost cap,
 * writes their inputs (and an empty checkout, which the sandbox expects) and the plan. A
 * bootstrap that's no longer requested or running is done: nothing runs.
 */
export async function prepareBootstrap(
  deps: ControlDeps,
  input: unknown,
  settings: Pick<PrepareSettings, "model" | "batchTimeoutMs">,
): Promise<PrepareOutput> {
  const job = bootstrapJobSchema.parse(input);
  const bootstrap = deps.bootstrap;
  if (bootstrap === undefined) throw new Error("This deployment doesn't run bootstraps.");
  const row = await bootstrap.store.get(job.bootstrapId);
  if (row === undefined || (row.status !== "requested" && row.status !== "running")) {
    return { runId: job.bootstrapId, superseded: true, batches: [] };
  }
  const github = await bootstrap.github(job.installationId);
  const repo = row.repo;
  const pulls = await github.mergedPulls(repo, {
    ...(row.beforePr === undefined ? {} : { before: row.beforePr }),
    limit: Math.min(row.maxPrs, BOOTSTRAP_DEFAULTS.maxPrsLimit),
  });
  const permissions = new Map<string, Promise<Permission>>();
  const permission = (login: string) => {
    const key = login.toLowerCase();
    let known = permissions.get(key);
    if (known === undefined) {
      known = github.permission(repo, login);
      permissions.set(key, known);
    }
    return known;
  };
  let held = 0;
  let read = 0;
  const prs = await mapLimited(pulls, 4, async (pr) => {
    const comments = await github.comments(repo, pr);
    read += comments.length;
    const selected = await selectComments(comments, permission);
    held += selected.held;
    return { pr, comments: selected.kept };
  });
  const maxCostUsd = Math.min(row.maxCostUsd, bootstrap.maxCostUsd);
  const maxBatches = Math.floor(maxCostUsd / BOOTSTRAP_BATCH_ESTIMATE_USD);
  const plan = planBatches(prs, maxBatches);
  const files = new Map<string, string | undefined>();
  for (const path of HINT_FILES) files.set(path, await github.file(repo, path));
  const hints = fileHints(files);

  const keys = runKeys(job.bootstrapId);
  const work = await deps.workDir();
  try {
    const empty = join(work.dir, "empty");
    await mkdir(empty);
    const archive = join(work.dir, "checkout.tar.gz");
    await deps.archive(empty, archive);
    await deps.store.putFile(keys.checkout, archive, "application/gzip");
  } finally {
    await work.remove();
  }
  const batches = plan.batches.map((batch, index) => ({ index, ...batch }));
  for (const batch of batches) {
    const batchInput: BatchInput = batchInputSchema.parse({
      version: 1,
      runId: job.bootstrapId,
      index: batch.index,
      prompt: buildBootstrapPrompt({
        repo,
        comments: batch.comments.map((comment) => ({
          id: comment.id,
          pr: comment.pr,
          ...(comment.path === undefined ? {} : { path: comment.path }),
          text: comment.text,
        })),
      }),
      role: "bootstrap",
      tier: BOOTSTRAPPER_TIER,
      model: settings.model,
      timeoutMs: Math.min(settings.batchTimeoutMs, BOOTSTRAP_TIMEOUT_MS),
    });
    await deps.store.putText(keys.batchInput(batch.index), JSON.stringify(batchInput));
  }
  const manifest: Manifest = {
    version: 1,
    kind: "bootstrap",
    bootstrapId: job.bootstrapId,
    repo,
    batches: batches.map((batch) => ({
      index: batch.index,
      comments: batch.comments.map(({ text: _, ...reference }) => reference),
    })),
    hints,
  };
  await deps.store.putText(keys.prepared, JSON.stringify(manifest));
  const commentsRead = plan.batches.reduce((sum, batch) => sum + batch.comments.length, 0);
  await bootstrap.store.progress(job.bootstrapId, {
    prsRead: plan.prsRead,
    commentsRead,
    oldestPrRead: plan.oldestPr,
    capped: plan.capped,
  });
  deps.log("bootstrap prepared", {
    bootstrapId: job.bootstrapId,
    repo,
    prs: pulls.length,
    prsRead: plan.prsRead,
    commentsSeen: read,
    commentsKept: commentsRead,
    held,
    batches: batches.length,
    hints: hints.length,
    capped: plan.capped,
  });
  return { runId: job.bootstrapId, superseded: false, batches: batches.map(({ index }) => ({ index })) };
}

/** Why a candidate wasn't stored, or the learning it became. */
export type CandidateOutcome =
  | { stored: true; learningId: string }
  | { stored: false; reason: string };

/**
 * Checks one candidate of a batch: its sources must be at least two distinct comments of that
 * batch, its text must pass the prompt-injection detector, and it must pass the write policy.
 * Returns the checked proposal and its sources, or why it's refused.
 */
export function checkCandidate(
  candidate: BootstrapCandidate,
  comments: Manifest["batches"][number]["comments"],
):
  | { ok: true; proposal: BootstrapProposal; sources: BootstrapSource[] }
  | { ok: false; reason: string } {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const cited = [...new Set(candidate.sources)].flatMap((id) => {
    const comment = byId.get(id);
    return comment === undefined ? [] : [comment];
  });
  if (cited.length < 2) return { ok: false, reason: "it rests on fewer than two of the comments" };
  if (scanText(candidate.text, { markdown: true }).length > 0) {
    return { ok: false, reason: "the prompt-injection detector flagged its text" };
  }
  return {
    ok: true,
    proposal: {
      kind: candidate.kind,
      text: candidate.text,
      ...(candidate.category === undefined ? {} : { category: candidate.category }),
      ...(candidate.path_glob === undefined ? {} : { pathGlob: candidate.path_glob }),
    },
    sources: cited.map((comment) => ({
      pr: comment.pr,
      commentId: comment.commentId,
      url: comment.url,
      ...(comment.path === undefined ? {} : { path: comment.path }),
    })),
  };
}

/**
 * The post step of a bootstrap: reads each batch's candidates, checks them, dedupes them against
 * the repository's learnings (pending and active) and each other, and stores at most
 * `MAX_PROPOSED` as pending, with their sources; then the file hints the same way. Repeating it
 * stores nothing twice. A bootstrap that isn't running any more is left alone.
 */
export async function postBootstrap(deps: ControlDeps, bootstrapId: string): Promise<void> {
  const bootstrap = deps.bootstrap;
  if (bootstrap === undefined) throw new Error("This deployment doesn't run bootstraps.");
  const row = await bootstrap.store.get(bootstrapId);
  if (row === undefined || (row.status !== "requested" && row.status !== "running")) return;
  const keys = runKeys(bootstrapId);
  const text = await deps.store.getText(keys.prepared);
  if (text === undefined) throw new Error(`Bootstrap ${bootstrapId} has no plan.`);
  const manifest = manifestSchema.parse(JSON.parse(text));
  const [owner = ""] = manifest.repo.split("/");
  const existing = await bootstrap.learnings.list({ org: owner, repo: manifest.repo });
  const seen = new Set(
    existing.filter((learning) => learning.status !== "retired").map((learning) => learningKey(learning)),
  );
  let proposed = 0;
  let refused = 0;
  let costUsd = 0;
  const store = async (proposal: BootstrapProposal, sources: BootstrapSource[]) => {
    if (proposed >= MAX_PROPOSED) return;
    const checked = checkBootstrapProposal(proposal);
    if (!checked.ok) {
      refused += 1;
      deps.log("bootstrap candidate refused", { bootstrapId, reason: checked.reason });
      return;
    }
    const key = learningKey({
      repo: manifest.repo,
      pathGlob: checked.proposal.scope.level === "path" ? checked.proposal.scope.pathGlob : undefined,
      text: checked.proposal.text,
    });
    if (seen.has(key)) return;
    seen.add(key);
    const learning = await storeBootstrapLearning(bootstrap.learnings, checked.proposal, manifest.repo);
    await bootstrap.store.addItem(bootstrapId, learning.id, sources);
    proposed += 1;
  };
  for (const batch of manifest.batches) {
    const output = await deps.store.getText(keys.batchOutput(batch.index));
    let candidates: BootstrapCandidate[] = [];
    if (output === undefined) {
      // Never finished: counted at its estimate, as it may have run.
      costUsd += BOOTSTRAP_BATCH_ESTIMATE_USD;
    } else {
      try {
        const parsed = batchOutputSchema.safeParse(JSON.parse(output));
        if (parsed.success && parsed.data.index === batch.index) {
          candidates = parsed.data.candidates ?? [];
          costUsd += parsed.data.usage?.costUsd ?? BOOTSTRAP_BATCH_ESTIMATE_USD;
          if (parsed.data.error !== undefined) {
            deps.log("bootstrap batch failed", { bootstrapId, index: batch.index });
          }
        } else {
          costUsd += BOOTSTRAP_BATCH_ESTIMATE_USD;
        }
      } catch {
        costUsd += BOOTSTRAP_BATCH_ESTIMATE_USD;
      }
    }
    for (const candidate of candidates) {
      const checked = checkCandidate(candidate, batch.comments);
      if (!checked.ok) {
        refused += 1;
        deps.log("bootstrap candidate refused", { bootstrapId, reason: checked.reason });
        continue;
      }
      await store(checked.proposal, checked.sources);
    }
  }
  for (const hint of manifest.hints) {
    await store(
      {
        kind: hint.proposal.kind,
        text: hint.proposal.text,
        ...(hint.proposal.category === undefined ? {} : { category: hint.proposal.category }),
        ...(hint.proposal.pathGlob === undefined ? {} : { pathGlob: hint.proposal.pathGlob }),
      },
      [{ file: hint.file }],
    );
  }
  await bootstrap.store.finish(bootstrapId, { proposed, costUsd });
  deps.log("bootstrap finished", { bootstrapId, repo: manifest.repo, proposed, refused, costUsd });
}
