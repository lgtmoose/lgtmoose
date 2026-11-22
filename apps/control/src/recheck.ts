import { posix } from "node:path";
import { isProtectedCategory, type Verdict } from "@lgtmoose/core";
import type { Repo } from "@lgtmoose/git";
import { batchOutputSchema, runKeys } from "@lgtmoose/pipeline";
import {
  MAX_RECHECK_FINDINGS,
  buildRecheckPrompt,
  codeExcerpt,
  type RecheckTarget,
} from "@lgtmoose/roles";
import { paragraphs } from "@lgtmoose/summary";
import { z } from "zod";
import type { ArtifactStore, FindingRecord } from "./ports.js";

/**
 * Carried findings checked again (NIC-1120). A finding stays open while its cited lines are
 * there, so one fixed somewhere else (a caller now passes the right value, a guard went in
 * before the call) used to stay open, and kept the decision at "changes requested", until
 * someone replied. Now, on an incremental review:
 *
 * - **Prepare** (`recheckJob`) picks our open blocking and should-fix findings the new commits
 *   may have fixed: those on a file the commits changed, and those whose file is related to a
 *   changed one (see `isRelated`). Blocking ones first, oldest first, at most
 *   `MAX_RECHECKS_PER_RUN`. They go to the recheck (`buildRecheckPrompt`) in one fast-tier
 *   batch, with the code each cited when it was raised and the diff since the last review.
 * - **Post** (`fixedByRecheck`) closes a finding as fixed only when the recheck's verdict says
 *   the problem is gone (`confirmed: false`), this run's review didn't raise it again, and, in a
 *   protected category (authz, tenant_scoping, money, secrets), the verdict names a changed file
 *   related to the finding, by its full path, as where the fix is. No verdict, a failed batch,
 *   or any doubt: it stays open. Then the decision is made again without it, its thread gets a
 *   reply saying where it was fixed, and the thread is resolved.
 *
 * The recheck only judges given findings against the code; plain code decides what closes. A
 * learning never closes a finding: the recheck's prompt has none.
 */

/** The most findings checked again in one run: one recheck batch. */
export const MAX_RECHECKS_PER_RUN = MAX_RECHECK_FINDINGS;

/** The longest a recheck may take: it reads a few findings' files, on the fast tier. */
export const RECHECK_TIMEOUT_MS = 10 * 60_000;

/** The most changed files whose imports are read to find related findings. */
const MAX_IMPORT_FILES = 50;
/** Files larger than this aren't read for imports. */
const MAX_IMPORT_BYTES = 256 * 1024;
/** The most diff text in the recheck's prompt. */
const MAX_DIFF_CHARS = 60_000;
/** Lines of code either side of a finding's cited lines in the prompt. */
const EXCERPT_CONTEXT = 15;

/** One finding in a run's recheck batch, as the manifest has it (trusted: written by prepare). */
export const recheckEntrySchema = z.object({
  /** The id the recheck's verdict refers to: `F1`, `F2`, … */
  id: z.string(),
  findingId: z.string(),
  fingerprint: z.string(),
  path: z.string(),
  ruleCategory: z.string(),
  severity: z.enum(["blocking", "should_fix", "nit"]),
  /** Our inline comment: the thread a "fixed" reply goes in. */
  githubCommentId: z.number().int().positive().optional(),
  /**
   * The changed files related to this finding (`isRelated`): where a fix the verdict names must
   * be, for a protected-category finding. Left out by runs before it: then none counts.
   */
  related: z.array(z.string()).optional(),
});

export type RecheckEntry = z.infer<typeof recheckEntrySchema>;

/** The run's recheck batch (`RunManifest.recheck`). */
export interface RecheckJob {
  index: number;
  /** The commit the PR was last reviewed at: what the change is measured from. */
  sinceSha: string;
  /** The files the new commits changed. */
  changed: string[];
  targets: RecheckEntry[];
}

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;

/** A path with its source extension and a trailing `/index` taken off, to match an import. */
function moduleKey(path: string): string {
  const bare = posix.normalize(path).replace(SOURCE_EXTENSIONS, "");
  return bare.endsWith("/index") ? bare.slice(0, -"/index".length) : bare;
}

const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"'\n]+)["']/g;

/** The modules a file imports by relative path, as `moduleKey`s from the repository root. */
export function relativeImports(path: string, text: string): Set<string> {
  const dir = posix.dirname(path);
  const found = new Set<string>();
  for (const match of text.matchAll(RELATIVE_IMPORT)) {
    const spec = match[1];
    if (spec === undefined) continue;
    const resolved = posix.normalize(posix.join(dir, spec));
    if (resolved.startsWith("..")) continue;
    found.add(moduleKey(resolved));
  }
  return found;
}

/**
 * Whether a change to `changed` may have fixed a finding on `path`. Plain code, not the model,
 * decides, and errs on the side of checking:
 *
 * - the same file, or a file in the same directory (a component and its hooks, a handler and
 *   its helpers: the pilot's saved-card fix was in the same feature folder);
 * - either file imports the other by a relative path (`imports`, read at head). The planner's
 *   cross-file pass works on the reviewer's notes, not an import graph, so this reads imports
 *   itself: relative specifiers only, which is what a fix next door usually is.
 */
export function isRelated(
  path: string,
  changed: string,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (path === changed) return true;
  if (posix.dirname(path) === posix.dirname(changed)) return true;
  return (
    (imports.get(path)?.has(moduleKey(changed)) ?? false) ||
    (imports.get(changed)?.has(moduleKey(path)) ?? false)
  );
}

/** A finding the recheck may close: open, blocking or should-fix, on the new side. */
function candidate(record: FindingRecord): boolean {
  return (
    record.status === "open" &&
    record.side === "RIGHT" &&
    (record.severity === "blocking" || record.severity === "should_fix")
  );
}

/** A file's text at head, for its imports: undefined when it's missing or too large to read. */
async function headText(repo: Repo, headSha: string, path: string): Promise<string | undefined> {
  try {
    // The blob's size in bytes first, so a large file is never read.
    const size = Number((await repo.git(["cat-file", "-s", `${headSha}:${path}`])).trim());
    if (!Number.isFinite(size) || size > MAX_IMPORT_BYTES) return undefined;
    return await repo.git(["show", `${headSha}:${path}`]);
  } catch {
    return undefined;
  }
}

/**
 * The findings this run checks again, in the order they're checked: blocking first, then
 * should-fix, each oldest first by the time of the commit it was raised at (`raisedAt`, seconds
 * by SHA; a commit without one sorts last), then in the order given, at most `limit`. Pure:
 * `imports` has each relevant file's relative imports at head.
 */
export function selectRechecks(
  records: readonly FindingRecord[],
  changed: readonly string[],
  imports: ReadonlyMap<string, ReadonlySet<string>>,
  limit: number = MAX_RECHECKS_PER_RUN,
  raisedAt: ReadonlyMap<string, number> = new Map(),
): FindingRecord[] {
  if (changed.length === 0 || limit <= 0) return [];
  const affected = records.filter(
    (record) => candidate(record) && changed.some((path) => isRelated(record.path, path, imports)),
  );
  const rank = (record: FindingRecord) => (record.severity === "blocking" ? 0 : 1);
  const when = (record: FindingRecord) => raisedAt.get(record.raisedAtSha) ?? Infinity;
  return affected
    .map((record, order) => ({ record, order }))
    .sort((a, b) => {
      const byRank = rank(a.record) - rank(b.record);
      if (byRank !== 0) return byRank;
      const at = when(a.record);
      const bt = when(b.record);
      if (at !== bt) return at < bt ? -1 : 1;
      return a.order - b.order;
    })
    .slice(0, limit)
    .map(({ record }) => record);
}

/**
 * When each commit was made, in seconds, by SHA. Each is read on its own, so one that's gone
 * (force-pushed away) leaves out only itself: its findings sort after the rest.
 */
async function commitTimes(repo: Repo, shas: readonly string[]): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  for (const sha of shas) {
    try {
      const seconds = Number((await repo.git(["show", "-s", "--format=%ct", sha])).trim());
      if (Number.isFinite(seconds)) times.set(sha, seconds);
    } catch {
      // Unread: its findings keep the order they came in, after the dated ones.
    }
  }
  return times;
}

async function excerptAt(repo: Repo, record: FindingRecord) {
  try {
    const text = await repo.git(["show", `${record.raisedAtSha}:${record.path}`]);
    return codeExcerpt(
      text.split("\n"),
      {
        line: record.line,
        ...(record.startLine === undefined ? {} : { start_line: record.startLine }),
      },
      EXCERPT_CONTEXT,
    );
  } catch {
    return undefined;
  }
}

/**
 * The run's recheck batch, or undefined when there's nothing to check: no commit to measure
 * from, nothing changed, or no open blocking or should-fix finding related to the change. Runs
 * before the checkout is sealed: it reads the commits the findings were raised at.
 */
export async function recheckJob(input: {
  repo: Repo;
  records: readonly FindingRecord[];
  /** Findings this run already acts on another way (a reply the judge reads): left out. */
  skip: ReadonlySet<string>;
  sinceSha: string | undefined;
  headSha: string;
  index: number;
  limit?: number;
  log(message: string, fields?: Record<string, unknown>): void;
}): Promise<(RecheckJob & { prompt: string }) | undefined> {
  const { repo, sinceSha, headSha } = input;
  if (sinceSha === undefined || sinceSha === headSha) return undefined;
  const open = input.records.filter((record) => candidate(record) && !input.skip.has(record.id));
  if (open.length === 0) return undefined;
  let changed: string[];
  try {
    await repo.fetchCommits([sinceSha]);
    const names = await repo.git(["diff", "--name-only", "--no-renames", sinceSha, headSha]);
    changed = names.split("\n").filter((name) => name.trim() !== "");
  } catch (error) {
    input.log("findings not rechecked: the change since the last review is unreadable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (changed.length === 0) return undefined;
  // Imports at head, of the findings' files and the changed ones.
  const paths = [
    ...new Set([...open.map((record) => record.path), ...changed.slice(0, MAX_IMPORT_FILES)]),
  ];
  const imports = new Map<string, Set<string>>();
  for (const path of paths) {
    if (!SOURCE_EXTENSIONS.test(path)) continue;
    const text = await headText(repo, headSha, path);
    if (text !== undefined) imports.set(path, relativeImports(path, text));
  }
  // The commits the findings were raised at: for their order, and the code they cited.
  const raisedShas = [...new Set(open.map((record) => record.raisedAtSha))];
  await repo.fetchCommits(raisedShas).catch(() => {
    // An excerpt that can't be read is left out; the recheck opens the file at head.
  });
  const chosen = selectRechecks(
    open,
    changed,
    imports,
    input.limit ?? MAX_RECHECKS_PER_RUN,
    await commitTimes(repo, raisedShas),
  );
  if (chosen.length === 0) return undefined;
  // The diff of the changed files related to a chosen finding: what the fix would be in.
  const relevant = changed.filter((path) =>
    chosen.some((record) => isRelated(record.path, path, imports)),
  );
  let diff = "";
  try {
    diff = await repo.git([
      "diff",
      "--no-color",
      "--no-ext-diff",
      sinceSha,
      headSha,
      "--",
      ...relevant,
    ]);
  } catch {
    diff = "";
  }
  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (the rest of the diff is left out: open the files to read it)`;
  }
  const targets: (RecheckTarget & { entry: RecheckEntry })[] = [];
  for (const [i, record] of chosen.entries()) {
    const id = `F${i + 1}`;
    const excerpt = await excerptAt(repo, record);
    targets.push({
      id,
      severity: record.severity,
      ruleCategory: record.ruleCategory,
      title: record.title,
      body: record.body,
      path: record.path,
      line: record.line,
      ...(record.startLine === undefined ? {} : { startLine: record.startLine }),
      raisedAtSha: record.raisedAtSha,
      ...(excerpt === undefined ? {} : { excerpt }),
      entry: {
        id,
        findingId: record.id,
        fingerprint: record.fingerprint,
        path: record.path,
        ruleCategory: record.ruleCategory,
        severity: record.severity,
        ...(record.githubCommentId === undefined
          ? {}
          : { githubCommentId: record.githubCommentId }),
        related: changed.filter((path) => isRelated(record.path, path, imports)),
      },
    });
  }
  input.log("findings to recheck", { count: targets.length, changed: changed.length });
  return {
    index: input.index,
    sinceSha,
    changed,
    targets: targets.map((target) => target.entry),
    prompt: buildRecheckPrompt({
      targets: targets.map(({ entry: _, ...target }) => target),
      headSha,
      sinceSha,
      diff,
    }),
  };
}

/**
 * The recheck batch's verdicts from its output object: undefined when there's no output, it
 * failed, or it doesn't validate. Model output, checked like any.
 */
export async function readVerdicts(
  store: ArtifactStore,
  runId: string,
  index: number,
): Promise<Verdict[] | undefined> {
  const text = await store.getText(runKeys(runId).batchOutput(index));
  if (text === undefined) return undefined;
  try {
    const parsed = batchOutputSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.index === index ? parsed.data.verdicts : undefined;
  } catch {
    return undefined;
  }
}

/** A finding the recheck showed is fixed, with the verdict's evidence. */
export interface RecheckFix {
  entry: RecheckEntry;
  reason: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a verdict's reason names one of `related` by its full repository path, standing on
 * its own: not inside a longer path or name (`src/web/index.ts` doesn't name `src/index.ts`, and
 * `mydb.ts` doesn't name `db.ts`). A trailing full stop or colon may follow it.
 */
export function namesRelatedFile(reason: string, related: readonly string[]): boolean {
  return related.some((path) =>
    new RegExp(`(?<![\\w./-])${escapeRegExp(path)}(?![\\w/-]|\\.[\\w/])`).test(reason),
  );
}

/**
 * The findings to close as fixed, from the recheck's verdicts. Pure. Only a verdict that says
 * the problem is gone counts; the first verdict for an id wins and unknown ids are ignored. A
 * finding this run's review raised again (`reraised`, by fingerprint) or that isn't open any
 * more (`open`, by ID) stays as it is. A protected-category finding also needs the verdict to
 * name, by its full path, one of the changed files related to it (`RecheckEntry.related`) as
 * where the fix is: "the problem is gone" alone isn't enough there.
 */
export function fixedByRecheck(
  job: Pick<RecheckJob, "targets">,
  verdicts: readonly Verdict[],
  context: { reraised: ReadonlySet<string>; open: ReadonlySet<string> },
): RecheckFix[] {
  const byId = new Map<string, Verdict>();
  for (const verdict of verdicts) if (!byId.has(verdict.id)) byId.set(verdict.id, verdict);
  const fixes: RecheckFix[] = [];
  for (const entry of job.targets) {
    const verdict = byId.get(entry.id);
    if (verdict === undefined || verdict.confirmed) continue;
    if (context.reraised.has(entry.fingerprint) || !context.open.has(entry.findingId)) continue;
    if (
      isProtectedCategory(entry.ruleCategory) &&
      !namesRelatedFile(verdict.reason, entry.related ?? [])
    ) {
      continue;
    }
    fixes.push({ entry, reason: verdict.reason });
  }
  return fixes;
}

/** What the post step decided about the run's recheck, saved once so a retry writes the same. */
export const recheckWritesSchema = z.object({
  version: z.literal(1),
  fixed: z.array(
    z.object({
      findingId: z.string(),
      githubCommentId: z.number().int().positive().optional(),
      reason: z.string(),
    }),
  ),
});

export type RecheckWrites = z.infer<typeof recheckWritesSchema>;

/** The reply in a fixed finding's thread: where the recheck saw the fix. Escaped. */
export function recheckReply(headSha: string, reason: string): string {
  return `This looks fixed at ${headSha.slice(0, 7)}, so it no longer counts against this pull request.\n\n${paragraphs(reason)}`;
}
