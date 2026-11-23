import { posix } from "node:path";
import { isProtectedCategory, type Verdict } from "@lgtmoose/core";
import { type LineRef, type Repo, trackLines } from "@lgtmoose/git";
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
 * someone replied. Now:
 *
 * - **Prepare** (`recheckJob`) picks, on an incremental review, our open blocking and should-fix
 *   findings the new commits may have fixed: those on a file the commits changed, and those
 *   whose file is related to a changed one (see `isRelated`). A full review (NIC-1123) read
 *   every file, so it picks from all of them, and measures the change from the oldest commit
 *   they were raised at (`fullReviewSince`). Either review also picks findings of any severity
 *   whose cited line is gone at head (NIC-1124): outdated, or going outdated in this run, on a
 *   file that changed. Open blocking ones first, then open should-fix, then those outdated
 *   (`rankRechecks`), oldest first, at most `MAX_RECHECKS_PER_RUN`. They go to the recheck
 *   (`buildRecheckPrompt`) in one fast-tier batch, with the code each cited when it was raised
 *   and the diff since then.
 * - **Post** (`fixedByRecheck`) closes a finding as fixed only when the recheck's verdict says
 *   the problem is gone (`confirmed: false`), this run's review didn't raise it again, and, in a
 *   protected category (authz, tenant_scoping, money, secrets), the verdict names a changed file
 *   related to the finding, by its full path, as where the fix is. No verdict, a failed batch,
 *   or any doubt: it stays open (or outdated). Then the decision is made again without it, its
 *   thread gets a reply saying where it was fixed, and the thread is resolved.
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
  /**
   * Its cited line is gone at head (NIC-1124): edited or deleted, by this run's commits or an
   * earlier run's, so it's `outdated` or goes `outdated` in this run. Its thread is resolved
   * when the recheck shows it's fixed. Left out: an open finding whose line is there.
   */
  outdated: z.boolean().optional(),
  /**
   * When a person said it's fixed (NIC-1140), as the run saw it: the post step clears that claim
   * once the recheck has looked, whatever it found. Left out: nobody had.
   */
  fixClaimedAt: z.string().optional(),
});

export type RecheckEntry = z.infer<typeof recheckEntrySchema>;

/**
 * How the run picked its findings (NIC-1123). `incremental` (left out by runs before it): the
 * commits since the last review, and the findings related to what they changed. `full`: a review
 * that read every file again (`full review`, or one that didn't come out incremental), and any
 * open blocking or should-fix finding, the change measured from when they were raised.
 */
export type RecheckMode = "incremental" | "full";

/** The run's recheck batch (`RunManifest.recheck`). */
export interface RecheckJob {
  index: number;
  /** How its findings were picked; left out: `incremental`. */
  mode?: RecheckMode;
  /**
   * What the change is measured from: the commit the PR was last reviewed at, or on a full
   * review the oldest commit a chosen finding was raised at that head still has (the PR's merge
   * base when none is left).
   */
  sinceSha: string;
  /** The files changed since `sinceSha`. */
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

const SEVERITY_RANK = { blocking: 0, should_fix: 1, nit: 2 } as const;

/**
 * Where a finding comes in the recheck's order, or undefined when the recheck doesn't check it.
 * New side only:
 *
 * - -1 (NIC-1140): someone said it's fixed, from the CLI or the dashboard: first, whatever its
 *   severity or line. The claim changes only the order (a claimed nit is checked too): it's
 *   picked by the same changed-file rules as the rest, and closes only by the recheck's rules;
 * - 0, 1: open blocking, then open should-fix, with its cited line still there;
 * - 2 to 4 (NIC-1124): open, any severity, nits included, its cited line gone at head
 *   (`lines`: edited or deleted, a committed suggestion among them), so it goes `outdated`
 *   in this run: blocking, should-fix, then nit;
 * - 5 to 7: outdated in an earlier run and still unresolved, its line still gone, by severity
 *   the same way.
 *
 * One outdated earlier whose cited line is back at head (a fix reverted) counts as open: 0 or 1,
 * never a nit. `lines` says, by finding ID, whether its cited line is at head (`lineStates`);
 * without an entry, an open one's is taken to be there and an outdated one's gone.
 */
function tier(record: FindingRecord, lines: LineStates): number | undefined {
  if (record.side !== "RIGHT") return undefined;
  if (record.status !== "open" && record.status !== "outdated") return undefined;
  if (record.fixClaimedAt !== undefined) return -1;
  const severity = SEVERITY_RANK[record.severity];
  if (lineGone(record, lines)) return (record.status === "outdated" ? 5 : 2) + severity;
  return severity < 2 ? severity : undefined;
}

/** Whether a finding's cited line is at head (`there`) or not (`gone`), by finding ID. */
export type LineStates = ReadonlyMap<string, "there" | "gone">;

/** Whether the finding's cited line is gone at head: it's outdated, or goes outdated now. */
function lineGone(record: FindingRecord, lines: LineStates): boolean {
  return (lines.get(record.id) ?? (record.status === "outdated" ? "gone" : "there")) === "gone";
}

/**
 * Whether each open or outdated new-side finding's cited line is at head (NIC-1124): followed
 * from the commit it was raised at, renames included, as the post step follows it. An open one
 * whose line is gone goes `outdated` in this run; an outdated one whose line is back is open
 * again. One whose lines can't be followed (its commit is gone) has no entry: the post step
 * can't place it either, so the recheck leaves it out.
 */
async function lineStates(
  repo: Repo,
  records: readonly FindingRecord[],
  headSha: string,
  /**
   * The files the PR changes that head has (from its merge base, deleted ones left out), as the
   * post step reads them: one whose file isn't among them can't be reviewed, so post marks it
   * outdated and never closes it. It gets no entry. Undefined: not read, every file counts.
   */
  prFiles: ReadonlySet<string> | undefined,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<Map<string, "there" | "gone">> {
  const states = new Map<string, "there" | "gone">();
  const tracked = records.filter(
    (record) =>
      record.side === "RIGHT" && (record.status === "open" || record.status === "outdated"),
  );
  const inPr = (path: string) => prFiles === undefined || prFiles.has(path);
  for (const [sha, group] of Map.groupBy(tracked, (record) => record.raisedAtSha)) {
    let moved: (LineRef | undefined)[];
    try {
      moved =
        sha === headSha
          ? group.map((record) => ({ path: record.path, line: record.line }))
          : await trackLines(
              repo,
              sha,
              headSha,
              group.map((record) => ({ path: record.path, line: record.line })),
            );
    } catch (error) {
      // Not followed: these get no entry, and aren't rechecked.
      log("findings not rechecked: their lines can't be followed", {
        sha,
        dropped: group.length,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const [i, record] of group.entries()) {
      const place = moved[i];
      if (!inPr(place?.path ?? record.path)) continue;
      states.set(record.id, place === undefined ? "gone" : "there");
    }
  }
  return states;
}

/** The paths `git diff --name-only` printed. */
function names(text: string): string[] {
  return text.split("\n").filter((name) => name.trim() !== "");
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
 * The findings an incremental review checks again, in the order they're checked (see
 * `rankRechecks`), at most `limit`. An open blocking or should-fix finding whose line is there
 * counts when its file is related to a changed one (`isRelated`); one whose cited line is gone
 * (NIC-1124: see `lines`) when its own file changed, since only a review of that file can close
 * it. Pure: `imports` has each relevant file's relative imports at head.
 */
export function selectRechecks(
  records: readonly FindingRecord[],
  changed: readonly string[],
  imports: ReadonlyMap<string, ReadonlySet<string>>,
  limit: number = MAX_RECHECKS_PER_RUN,
  raisedAt: ReadonlyMap<string, number> = new Map(),
  lines: LineStates = new Map(),
): FindingRecord[] {
  if (changed.length === 0 || limit <= 0) return [];
  const affected = records.filter((record) => {
    if (tier(record, lines) === undefined) return false;
    // A fix claim (NIC-1140) only moves a finding up the order: it's picked by the same
    // changed-file rules as any other, so a claim and an unrelated push can't close it.
    if (lineGone(record, lines)) return changed.includes(record.path);
    return changed.some((path) => isRelated(record.path, path, imports));
  });
  return rankRechecks(affected, limit, raisedAt, lines);
}

/**
 * Findings in the order they're checked: open blocking, then open should-fix, then those whose
 * cited line this run's head no longer has (NIC-1124, see `lines`: blocking, should-fix, then
 * nit), then those outdated by an earlier run (the same way); within each, oldest first by
 * `raisedAt` (seconds by SHA; a commit without one sorts last), then in the order given, at most
 * `limit`. Others are left out (see `tier`). Pure. A full review (NIC-1123) picks this way from
 * the findings whose change it can see (see `recheckJob`).
 */
export function rankRechecks(
  records: readonly FindingRecord[],
  limit: number = MAX_RECHECKS_PER_RUN,
  raisedAt: ReadonlyMap<string, number> = new Map(),
  lines: LineStates = new Map(),
): FindingRecord[] {
  if (limit <= 0) return [];
  const rank = (record: FindingRecord) => tier(record, lines) ?? Infinity;
  const when = (record: FindingRecord) => raisedAt.get(record.raisedAtSha) ?? Infinity;
  return records
    .filter((record) => tier(record, lines) !== undefined)
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

/**
 * Where a full review's recheck measures the change from (NIC-1123): the oldest commit one of
 * `chosen` was raised at that's still in head's history, so the diff covers every fix since any
 * of them; the PR's merge base when none is (a force-push dropped them all); undefined when
 * neither can be read.
 */
export async function fullReviewSince(
  repo: Pick<Repo, "git">,
  chosen: readonly Pick<FindingRecord, "raisedAtSha">[],
  raisedAt: ReadonlyMap<string, number>,
  headSha: string,
  baseSha: string | undefined,
): Promise<string | undefined> {
  const when = (sha: string) => raisedAt.get(sha) ?? Infinity;
  const shas = [...new Set(chosen.map((record) => record.raisedAtSha))]
    .filter((sha) => sha !== headSha)
    .sort((a, b) => when(a) - when(b));
  for (const sha of shas) {
    try {
      await repo.git(["merge-base", "--is-ancestor", sha, headSha]);
      return sha;
    } catch {
      // Not in head's history (force-pushed away, or never fetched): try the next.
    }
  }
  if (baseSha === undefined) return undefined;
  try {
    const base = (await repo.git(["merge-base", baseSha, headSha])).trim();
    return base === "" ? undefined : base;
  } catch {
    return undefined;
  }
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
 * from, nothing changed, or no finding to pick (see `selectRechecks` and `rankRechecks`). Runs
 * before the checkout is sealed: it reads the commits the findings were raised at.
 */
export async function recheckJob(input: {
  repo: Repo;
  records: readonly FindingRecord[];
  /** Findings this run already acts on another way (a reply the judge reads): left out. */
  skip: ReadonlySet<string>;
  sinceSha: string | undefined;
  headSha: string;
  /**
   * The PR's base: files the PR itself changes (from the merge base to head) come first, so a
   * merge of the base branch can't crowd them out of the imports read and the diff.
   */
  baseSha?: string;
  index: number;
  limit?: number;
  /**
   * `full` (NIC-1123): the review reads every file again, so any open blocking or should-fix
   * finding is picked, and the change is measured from when they were raised (`sinceSha` is
   * ignored). Left out: `incremental`.
   */
  mode?: RecheckMode;
  log(message: string, fields?: Record<string, unknown>): void;
}): Promise<(RecheckJob & { prompt: string }) | undefined> {
  const { repo, headSha } = input;
  const mode = input.mode ?? "incremental";
  const limit = input.limit ?? MAX_RECHECKS_PER_RUN;
  if (mode === "incremental" && (input.sinceSha === undefined || input.sinceSha === headSha)) {
    return undefined;
  }
  // Our open and outdated new-side findings: nits too, as one whose line went may be fixed.
  const tracked = input.records.filter(
    (record) =>
      record.side === "RIGHT" &&
      (record.status === "open" || record.status === "outdated") &&
      !input.skip.has(record.id),
  );
  if (tracked.length === 0) return undefined;
  // The commits the findings were raised at: for their order, the code they cited, whether their
  // line is still there and, on a full review, where the change is measured from.
  const trackedShas = [...new Set(tracked.map((record) => record.raisedAtSha))];
  await repo.fetchCommits(trackedShas).catch(() => {
    // An excerpt that can't be read is left out; the recheck opens the file at head.
  });
  // The PR's own changed files (from its merge base): to put first, and those head has, which
  // are the only ones a review reads.
  const prDiff = (...flags: string[]) =>
    input.baseSha === undefined
      ? Promise.resolve(undefined)
      : repo
          .git(["diff", "--name-only", "--no-renames", ...flags, `${input.baseSha}...${headSha}`])
          .then((text) => new Set(names(text)))
          .catch(() => undefined);
  const theirs = await prDiff();
  const prFiles = await prDiff("--diff-filter=d");
  // Whether each one's cited line is at head (NIC-1124), on a file the PR still changes. One
  // that can't be followed (its commit is gone), or whose file the PR no longer changes, is left
  // out: the post step can't place it or review its file, so nothing could close it.
  const lines = await lineStates(repo, tracked, headSha, prFiles, (message, fields) =>
    input.log(message, fields),
  );
  const open = tracked.filter(
    (record) => lines.has(record.id) && tier(record, lines) !== undefined,
  );
  if (open.length === 0) return undefined;
  const raisedAt = await commitTimes(repo, [...new Set(open.map((record) => record.raisedAtSha))]);
  // The PR's own first; what only a merge of the base brought in after.
  const ownFirst = (paths: readonly string[]) =>
    theirs === undefined
      ? [...paths]
      : [...paths.filter((path) => theirs.has(path)), ...paths.filter((path) => !theirs.has(path))];
  const changedSince = async (sha: string) => {
    await repo.fetchCommits([sha]);
    return ownFirst(names(await repo.git(["diff", "--name-only", "--no-renames", sha, headSha])));
  };
  // Imports at head, read once per file.
  const imports = new Map<string, Set<string>>();
  const readImports = async (paths: Iterable<string>) => {
    for (const path of paths) {
      if (imports.has(path) || !SOURCE_EXTENSIONS.test(path)) continue;
      const text = await headText(repo, headSha, path);
      imports.set(path, text === undefined ? new Set() : relativeImports(path, text));
    }
  };
  // A full review (NIC-1123) picks with no related-file filter, but only findings with a change
  // to look at: raised before head, with their file or a related one changed since the commit
  // each was raised at. One with nothing changed since has nothing that could have fixed it.
  let picked: FindingRecord[] | undefined;
  const ownChanged = new Map<string, string[]>();
  if (mode === "full") {
    const pool = open.filter((record) => record.raisedAtSha !== headSha);
    for (const sha of new Set(pool.map((record) => record.raisedAtSha))) {
      try {
        ownChanged.set(sha, await changedSince(sha));
      } catch {
        // Its change can't be read: its findings aren't rechecked.
      }
    }
    await readImports(pool.map((record) => record.path));
    await readImports([...new Set([...ownChanged.values()].flat())].slice(0, MAX_IMPORT_FILES));
    picked = rankRechecks(
      pool.filter((record) =>
        (ownChanged.get(record.raisedAtSha) ?? []).some((path) =>
          isRelated(record.path, path, imports),
        ),
      ),
      limit,
      raisedAt,
      lines,
    );
    if (picked.length === 0) return undefined;
  }
  const sinceSha =
    picked === undefined
      ? (input.sinceSha as string)
      : await fullReviewSince(repo, picked, raisedAt, headSha, input.baseSha);
  if (sinceSha === undefined) {
    input.log("findings not rechecked: no commit to measure the change from", { mode });
    return undefined;
  }
  let changed: string[];
  try {
    changed = await changedSince(sinceSha);
  } catch (error) {
    input.log("findings not rechecked: the change since the last review is unreadable", {
      mode,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  // Only what the commits may have fixed is rechecked: nothing changed, nothing to recheck.
  if (changed.length === 0) return undefined;
  // Imports at head, of the findings' files and the changed ones.
  await readImports(open.map((record) => record.path));
  await readImports(changed.slice(0, MAX_IMPORT_FILES));
  const chosen = picked ?? selectRechecks(open, changed, imports, limit, raisedAt, lines);
  if (chosen.length === 0) return undefined;
  // On a full review, whether each chosen finding's commit is in head's history. One that isn't
  // (force-pushed away) diffs against head with whatever a rebase brought in from the base.
  const inHistory = new Map<string, boolean>();
  if (picked !== undefined) {
    for (const sha of new Set(chosen.map((record) => record.raisedAtSha))) {
      inHistory.set(
        sha,
        await repo.git(["merge-base", "--is-ancestor", sha, headSha]).then(
          () => true,
          () => false,
        ),
      );
    }
  }
  // The changed files a finding's fix could be in: since the last review on an incremental
  // review; on a full review, since the commit that finding was raised at, so a protected
  // finding's fix is never a file changed before it was raised. When that commit isn't in
  // head's history, its diff to head holds the base's changes too: a protected finding gets
  // none (so it can't close on this run), any other the change since `sinceSha`.
  const relatedOf = (record: FindingRecord) => {
    let from: readonly string[] = changed;
    if (picked !== undefined && inHistory.get(record.raisedAtSha) === true) {
      from = ownChanged.get(record.raisedAtSha) ?? [];
    } else if (picked !== undefined && isProtectedCategory(record.ruleCategory)) {
      input.log("protected finding can't close on this run: its commit isn't in head's history", {
        findingId: record.id,
        raisedAtSha: record.raisedAtSha,
      });
      return [];
    }
    return from.filter((path) => isRelated(record.path, path, imports));
  };
  // The diff of the changed files related to a chosen finding: what the fix would be in. On a
  // full review, and for a finding whose cited line is gone (NIC-1124), the finding's own file
  // first, so its change is never cut off.
  const own = new Set(
    chosen
      .filter((record) => picked !== undefined || lineGone(record, lines))
      .map((record) => record.path)
      .filter((path) => changed.includes(path)),
  );
  // Then the changed files related to a chosen finding, where a fix usually is. A full review
  // takes the unrelated ones last, so on a large PR they can never crowd a fix out of the budget.
  const related = changed.filter(
    (path) => !own.has(path) && chosen.some((record) => isRelated(record.path, path, imports)),
  );
  const relatedSet = new Set(related);
  const relevant = [
    ...own,
    ...related,
    ...(picked === undefined
      ? []
      : changed.filter((path) => !own.has(path) && !relatedSet.has(path))),
  ];
  // In `changed`'s order (the PR's own files first), which git's own path order wouldn't keep.
  let diff = "";
  for (const path of relevant) {
    if (diff.length > MAX_DIFF_CHARS) break;
    try {
      diff += await repo.git([
        "diff",
        "--no-color",
        "--no-ext-diff",
        sinceSha,
        headSha,
        "--",
        path,
      ]);
    } catch {
      // A file whose diff can't be read is left out; the recheck can open it.
    }
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
      ...(lineGone(record, lines) ? { citedLineChanged: true } : {}),
      ...(inHistory.get(record.raisedAtSha) === false ? { raisedCommitGone: true } : {}),
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
        related: relatedOf(record),
        ...(lineGone(record, lines) ? { outdated: true } : {}),
        ...(record.fixClaimedAt === undefined ? {} : { fixClaimedAt: record.fixClaimedAt }),
      },
    });
  }
  input.log("findings to recheck", {
    count: targets.length,
    outdated: targets.filter((target) => target.entry.outdated === true).length,
    claimedFixed: targets.filter((target) => target.entry.fixClaimedAt !== undefined).length,
    changed: changed.length,
    mode,
  });
  return {
    index: input.index,
    ...(mode === "full" ? { mode } : {}),
    sinceSha,
    changed,
    targets: targets.map((target) => target.entry),
    prompt: buildRecheckPrompt({
      targets: targets.map(({ entry: _, ...target }) => target),
      headSha,
      sinceSha,
      diff,
      ...(picked === undefined
        ? {}
        : {
            fixAfterRaised: true,
            // `fullReviewSince` fell back to the merge base: no chosen finding's commit is it.
            ...(picked.some((record) => record.raisedAtSha === sinceSha)
              ? {}
              : { sinceIsMergeBase: true }),
          }),
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

/**
 * The fix claims (NIC-1140) the recheck settled, by finding ID: a claimed finding it closed
 * (`fixed`), or one whose verdict says the problem is still there, on a file this review read
 * well enough to trust it (`readEnough`). Pure. A claim whose finding the plan didn't close for
 * another reason (its file unreviewed, its batch failed), or that got no verdict, isn't settled:
 * it stays first in the next run's recheck.
 */
export function settledFixClaims(
  targets: readonly RecheckEntry[],
  verdicts: readonly Verdict[],
  fixed: ReadonlySet<string>,
  readEnough: (entry: RecheckEntry) => boolean,
): string[] {
  const byId = new Map<string, Verdict>();
  for (const verdict of verdicts) if (!byId.has(verdict.id)) byId.set(verdict.id, verdict);
  return targets.flatMap((entry) =>
    entry.fixClaimedAt !== undefined &&
    (fixed.has(entry.findingId) || (byId.get(entry.id)?.confirmed === true && readEnough(entry)))
      ? [entry.findingId]
      : [],
  );
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
  /** The fix claims it settled (`settledFixClaims`). Left out by attempts from before it was kept. */
  settledClaims: z.array(z.string()).optional(),
});

export type RecheckWrites = z.infer<typeof recheckWritesSchema>;

/** The reply in a fixed finding's thread: where the recheck saw the fix. Escaped. */
export function recheckReply(headSha: string, reason: string): string {
  return `This looks fixed at ${headSha.slice(0, 7)}, so it no longer counts against this pull request.\n\n${paragraphs(reason)}`;
}
