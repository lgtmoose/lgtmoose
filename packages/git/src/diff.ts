import type { Repo } from "./clone.js";
import { importLines, languageOf } from "./imports.js";
import { parsePatch, type FilePatch, type Hunk } from "./patch.js";
import { listTree } from "./tree.js";

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "type-changed";

export interface FileDiff {
  /** Path at head; for deleted files, the path at the base. */
  path: string;
  /** Path at the base, when it differs (renames). */
  oldPath?: string;
  status: FileStatus;
  oldBlob: string | undefined;
  newBlob: string | undefined;
  /** A submodule pointer (gitlink): its "blobs" are commits in another repository. */
  submodule: boolean;
  /** Renamed with identical contents (same blob). Nothing to review in it. */
  moved: boolean;
  /**
   * The edit only touches import statements (and blank lines around them), such as the knock-on
   * of a move. Worth a glance, not a review. Needs at least one changed import line.
   */
  mechanical: boolean;
  binary: boolean;
  hunks: Hunk[];
  /**
   * Incremental reviews only: head-side lines the PR adds that changed since the last reviewed
   * commit. Hunks still describe the whole PR diff, since review comments must sit on lines
   * GitHub shows in the PR.
   */
  changedSinceLastReview?: number[];
  /**
   * Incremental reviews only: lines the PR added at the last review but no longer adds, such as
   * a requested check that was taken out again. They're not in the PR diff, so they can't take
   * inline comments; mention them in the review body.
   */
  removedSinceLastReview?: string[];
}

export interface ReviewDiff {
  kind: "full" | "incremental";
  /** The merge base of the base branch and head: the PR's starting point. */
  mergeBase: string;
  headSha: string;
  lastReviewed?: string;
  /** Why an incremental review fell back to a full one, for some files or all. */
  fallbackReason?: string;
  files: FileDiff[];
  /**
   * Every file the PR changes against the merge base, whatever the kind: `files` itself for a
   * full review.
   */
  prFiles: FileDiff[];
  /**
   * Incremental reviews with `reviewedAt` only: paths reviewed at a commit still here whose PR
   * change hasn't moved since, so they're covered at this head too (whether or not the PR still
   * changes them). Not in `files`.
   */
  unchanged: { path: string; reviewedAs: string }[];
}

export interface DiffOptions {
  /** The base branch's head commit. */
  baseSha: string;
  /**
   * The commit each path (as it was named then) was last reviewed at. A path with no entry has
   * never been reviewed, so its whole PR diff is reviewed. Omit for a first review.
   */
  reviewedAt?: ReadonlyMap<string, string>;
}

const STATUS: Record<string, FileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  T: "type-changed",
};

const GITLINK = "160000";

interface RawEntry {
  status: FileStatus;
  oldMode: string;
  newMode: string;
  oldBlob: string | undefined;
  newBlob: string | undefined;
  oldPath: string;
  newPath: string;
}

const ZERO_SHA = /^0+$/;

/** Parses `git diff --raw -z`: modes, blob SHAs and statuses, with paths that need no unquoting. */
function parseRaw(text: string): RawEntry[] {
  const fields = text.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < fields.length;) {
    const meta = fields[i++];
    if (!meta?.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldBlob = "", newBlob = "", code = ""] = meta
      .slice(1)
      .split(" ");
    const letter = code[0] ?? "M";
    const oldPath = fields[i++] ?? "";
    // Copies aren't detected (no --find-copies), so only renames carry a second path.
    const newPath = letter === "R" ? (fields[i++] ?? "") : oldPath;
    entries.push({
      status: STATUS[letter] ?? "modified",
      oldMode,
      newMode,
      oldBlob: ZERO_SHA.test(oldBlob) ? undefined : oldBlob,
      newBlob: ZERO_SHA.test(newBlob) ? undefined : newBlob,
      oldPath,
      newPath,
    });
  }
  return entries;
}

const DIFF_FLAGS = [
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--find-renames",
  // Full blob IDs: --raw abbreviates them otherwise.
  "--no-abbrev",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

const keyOf = (entry: { status: FileStatus; oldPath: string; newPath: string }) =>
  entry.status === "deleted" ? entry.oldPath : entry.newPath;

/** Whether an entry's lines could be import-only, so its contents are worth reading. */
function mightBeMechanical(entry: RawEntry): boolean {
  const submodule = entry.oldMode === GITLINK || entry.newMode === GITLINK;
  return !submodule && languageOf(entry.newPath) !== undefined;
}

function isMechanical(entry: RawEntry, patch: FilePatch, blobs: Map<string, Buffer>): boolean {
  if (patch.binary || !mightBeMechanical(entry)) return false;
  const changed = patch.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "context"));
  const text = (blob: string | undefined) =>
    blob === undefined ? "" : (blobs.get(blob)?.toString("utf8") ?? "");
  const oldImports = importLines(entry.oldPath, text(entry.oldBlob));
  const newImports = importLines(entry.newPath, text(entry.newBlob));
  let touchesImport = false;
  const allImportOrBlank = changed.every((line) => {
    const isImport =
      line.kind === "add" ? newImports.has(line.newLine ?? 0) : oldImports.has(line.oldLine ?? 0);
    touchesImport ||= isImport;
    return isImport || line.text.trim() === "";
  });
  return allImportOrBlank && touchesImport;
}

/** Puts both halves of a type change (file to symlink, say) under one path. */
function mergePatches(patches: FilePatch[]): Map<string, FilePatch> {
  const byPath = new Map<string, FilePatch>();
  for (const patch of patches) {
    const key = patch.newPath ?? patch.oldPath ?? "";
    const existing = byPath.get(key);
    if (existing === undefined) {
      byPath.set(key, patch);
      continue;
    }
    byPath.set(key, {
      oldPath: existing.oldPath ?? patch.oldPath,
      newPath: patch.newPath ?? existing.newPath,
      binary: existing.binary || patch.binary,
      hunks: [...existing.hunks, ...patch.hunks],
    });
  }
  return byPath;
}

/** Every file the range `from..to` changes, with hunks and blob SHAs. */
async function diffRange(
  repo: Repo,
  from: string,
  to: string,
  {
    detectMechanical = true,
    paths,
  }: {
    detectMechanical?: boolean;
    /**
     * Only files with one of these paths on either side. Renames are still found: the file list
     * comes from the whole diff, and only the patch is limited (to both sides' paths).
     */
    paths?: readonly string[];
  } = {},
): Promise<FileDiff[]> {
  let entries: RawEntry[];
  let patch: string;
  if (paths === undefined) {
    const [raw, text] = await Promise.all([
      repo.git([...DIFF_FLAGS, "--raw", "-z", from, to]),
      repo.git([...DIFF_FLAGS, "--unified=3", from, to]),
    ]);
    entries = parseRaw(raw);
    patch = text;
  } else {
    const wanted = new Set(paths);
    entries = parseRaw(await repo.git([...DIFF_FLAGS, "--raw", "-z", from, to])).filter(
      (entry) => wanted.has(entry.oldPath) || wanted.has(entry.newPath),
    );
    const sides = [...new Set(entries.flatMap((entry) => [entry.oldPath, entry.newPath]))];
    patch =
      sides.length === 0
        ? ""
        : await repo.git([
            ...DIFF_FLAGS,
            "--unified=3",
            from,
            to,
            "--",
            ...sides.map((path) => `:(literal)${path}`),
          ]);
  }
  const patches = mergePatches(parsePatch(patch));
  // One batched read for every blob mechanical detection needs, instead of a process each.
  const candidates = entries.filter(mightBeMechanical);
  // After a full checkout, head's versions are on disk already; only the other side needs fetching.
  const headSide = repo.fullCheckout && to === repo.headSha;
  const blobs = detectMechanical
    ? await repo.readBlobs(
        candidates
          .flatMap((e) => [e.oldBlob, e.newBlob])
          .filter((blob): blob is string => blob !== undefined),
        {
          local: headSide
            ? candidates.flatMap((e) => (e.newBlob === undefined ? [] : [e.newBlob]))
            : [],
        },
      )
    : new Map<string, Buffer>();

  return entries.map((entry) => {
    const key = keyOf(entry);
    const filePatch = patches.get(key) ?? {
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      binary: false,
      hunks: [],
    };
    const moved =
      entry.status === "renamed" && entry.oldBlob !== undefined && entry.oldBlob === entry.newBlob;
    return {
      path: key,
      ...(entry.oldPath !== key ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      oldBlob: entry.oldBlob,
      newBlob: entry.newBlob,
      submodule: entry.oldMode === GITLINK || entry.newMode === GITLINK,
      moved,
      mechanical: !moved && detectMechanical && isMechanical(entry, filePatch, blobs),
      binary: filePatch.binary,
      hunks: filePatch.hunks,
    } satisfies FileDiff;
  });
}

/** The blob (or gitlink) each of these paths has at `sha`; paths it doesn't have are left out. */
async function blobsAt(
  repo: Repo,
  sha: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const entries = await listTree((args) => repo.git(args), sha, paths);
  return new Map(
    entries.flatMap((entry) =>
      entry.type === "blob" || entry.type === "commit" ? [[entry.path, entry.sha] as const] : [],
    ),
  );
}

/**
 * Every file `from..to` changes, with hunks and blob SHAs, as a plain commit-to-commit diff (no
 * merge base, no mechanical detection). For following lines from one commit to another.
 */
export function diffCommits(
  repo: Repo,
  from: string,
  to: string,
  options: { paths?: readonly string[] } = {},
): Promise<FileDiff[]> {
  return diffRange(repo, from, to, { detectMechanical: false, ...options });
}

/** Head-side line numbers each file's diff adds. */
function addedLines(file: FileDiff): Set<number> {
  return new Set(
    file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.newLine ?? 0)),
  );
}

/** The added lines' text, counted, so a line the PR stopped adding can be found. */
function addedTexts(file: FileDiff | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of file?.hunks.flatMap((h) => h.lines) ?? []) {
    if (line.kind === "add") counts.set(line.text, (counts.get(line.text) ?? 0) + 1);
  }
  return counts;
}

/** Lines that say nothing on their own: blank, or only brackets and punctuation. */
const TRIVIAL = /^[\s{}()[\];,.]*$/;

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);

/** Share of words two lines have in common (Jaccard). 1 for identical word sets. */
function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Lines whose replacement in the same hunk keeps at least half their words count as reworded. */
const REWORDED = 0.5;

/**
 * Texts of lines reworded since the last review: removed in a hunk that adds a similar line.
 * A line replaced by something unrelated (a check swapped for a log line) isn't a rewording,
 * so it stays in the removed list.
 */
function rewordedTexts(changed: FileDiff | undefined): Set<string> {
  const texts = new Set<string>();
  for (const hunk of changed?.hunks ?? []) {
    const added = hunk.lines.filter((l) => l.kind === "add").map((l) => l.text);
    for (const line of hunk.lines) {
      if (line.kind === "del" && added.some((text) => similarity(line.text, text) >= REWORDED)) {
        texts.add(line.text);
      }
    }
  }
  return texts;
}

/**
 * Lines the PR added at the last review but no longer adds, leaving out trivial lines and
 * rewordings, so what's left is worth a reader's attention (a removed check, say).
 */
function removedTexts(
  before: FileDiff | undefined,
  after: FileDiff | undefined,
  changed?: FileDiff,
): string[] {
  const now = addedTexts(after);
  const reworded = rewordedTexts(changed);
  const removed: string[] = [];
  for (const [text, count] of addedTexts(before)) {
    if (TRIVIAL.test(text) || reworded.has(text)) continue;
    for (let i = now.get(text) ?? 0; i < count; i++) removed.push(text);
  }
  return removed;
}

/** What one baseline commit gives: the PR's diff back then, and what changed since. */
interface Baseline {
  since: Map<string, FileDiff>;
  previous: Map<string, FileDiff>;
  previousFiles: FileDiff[];
  /** Paths renamed since then, to their new names; the previous diff has the old names. */
  movedAway: Map<string, string>;
}

async function baseline(
  repo: Repo,
  baseSha: string,
  sha: string,
  paths: readonly string[],
): Promise<Baseline> {
  const previousBase = (await repo.git(["merge-base", baseSha, sha])).trim();
  // Only the files reviewed at this commit matter here; renames are still found.
  const [sinceFiles, previousFiles] = await Promise.all([
    diffRange(repo, sha, repo.headSha, { detectMechanical: false, paths }),
    diffRange(repo, previousBase, sha, { detectMechanical: false, paths }),
  ]);
  return {
    since: new Map(sinceFiles.map((f) => [f.path, f])),
    previous: new Map(previousFiles.map((f) => [f.path, f])),
    previousFiles,
    movedAway: new Map(
      sinceFiles.flatMap((f) => (f.oldPath === undefined ? [] : [[f.oldPath, f.path] as const])),
    ),
  };
}

/** How many baselines are diffed at once. */
const BASELINES_AT_ONCE = 4;

/**
 * What changed in one file's PR change since its baseline: the file with its incremental
 * notes, or undefined when nothing did (the PR adds the same lines, moved or not, and stopped
 * adding nothing).
 */
function sinceBaseline(file: FileDiff, base: Baseline, reviewedPath: string): FileDiff | undefined {
  const changed = base.since.get(file.path);
  if (file.status === "deleted") {
    // Deleted since the last review (it still existed then).
    return changed?.status === "deleted"
      ? { ...file, changedSinceLastReview: [], removedSinceLastReview: [] }
      : undefined;
  }
  // The PR's diff of the file back then, under the path it had then.
  const before = base.previous.get(reviewedPath);
  const removed = removedTexts(before, file, changed);
  const prLines = addedLines(file);
  const newLines = changed
    ? [...addedLines(changed)].filter((line) => prLines.has(line)).sort((a, b) => a - b)
    : [];
  const renamedSince = changed?.status === "renamed" && file.status === "renamed";
  if (newLines.length === 0 && removed.length === 0 && !renamedSince) return undefined;
  return { ...file, changedSinceLastReview: newLines, removedSinceLastReview: removed };
}

/**
 * The diff to review.
 *
 * A first review covers `base...head`: everything from the merge base to head, which leaves out
 * whatever the base branch did meanwhile.
 *
 * An incremental review keeps the same PR diff, but only the files where the PR's own changes
 * moved since they were last reviewed: lines it adds that changed since then, and lines it
 * added then but no longer does. Both come from comparing the PR's diff, not the commits, so
 * changes that arrived by merging the base branch into the PR, and the base-branch changes a
 * rebase brings, drop out. Each file is compared with its own last review (`reviewedAt`),
 * found under its new name if it was renamed since; a file never reviewed is reviewed whole.
 * A file whose last reviewed commit is gone (force-pushed away) is reviewed whole too.
 *
 * Files the PR stopped changing altogether are listed with what they no longer add, when they
 * still exist; a file the PR added and dropped again has nothing left to review.
 */
export async function reviewDiff(repo: Repo, options: DiffOptions): Promise<ReviewDiff> {
  const mergeBase = (await repo.git(["merge-base", options.baseSha, repo.headSha])).trim();
  const files = await diffRange(repo, mergeBase, repo.headSha);
  const result = { mergeBase, headSha: repo.headSha, prFiles: files };
  const { reviewedAt } = options;
  if (reviewedAt === undefined || reviewedAt.size === 0) {
    return { ...result, kind: "full", files, unchanged: [] };
  }

  // Every baseline commit in use, with what it gives (undefined when it's gone), each diffed
  // only for the paths reviewed there.
  const pathsAt = new Map<string, string[]>();
  for (const [path, sha] of reviewedAt) {
    const paths = pathsAt.get(sha);
    if (paths === undefined) pathsAt.set(sha, [path]);
    else paths.push(path);
  }
  const baselines = new Map<string, Baseline | undefined>();
  const shas = [...pathsAt.keys()];
  for (let i = 0; i < shas.length; i += BASELINES_AT_ONCE) {
    const chunk = shas.slice(i, i + BASELINES_AT_ONCE);
    const built = await Promise.all(
      chunk.map(async (sha): Promise<Baseline | undefined> => {
        const paths = new Set(pathsAt.get(sha));
        if (sha === repo.headSha) {
          // Reviewed at this very head: nothing has changed since.
          const same = files.filter((f) => paths.has(f.path));
          return {
            since: new Map(),
            previous: new Map(same.map((f) => [f.path, f])),
            previousFiles: same,
            movedAway: new Map(),
          };
        }
        if (!(await repo.hasCommit(sha))) return undefined;
        return baseline(repo, options.baseSha, sha, [...paths]);
      }),
    );
    for (const [j, sha] of chunk.entries()) baselines.set(sha, built[j]);
  }
  // A file renamed since its last review is found under its new name.
  const renamedFrom = new Map<string, string>();
  for (const [sha, base] of baselines) {
    for (const [from, to] of base?.movedAway ?? []) {
      if (reviewedAt.get(from) === sha) renamedFrom.set(to, from);
    }
  }

  // Each path ends up planned (in `files`) or covered (`unchanged`), never both.
  const planned = new Map<string, FileDiff>();
  /** Covered path to the name it was last reviewed under. */
  const unchanged = new Map<string, string>();
  const handled = new Set<string>();
  const plan = (file: FileDiff) => {
    planned.set(file.path, file);
    unchanged.delete(file.path);
    handled.add(file.path);
  };
  const cover = (path: string, reviewedAs = path) => {
    if (!planned.has(path)) unchanged.set(path, reviewedAs);
    handled.add(path);
  };
  const gone: string[] = [];
  let compared = false;
  for (const file of files) {
    const reviewedPath = reviewedAt.has(file.path)
      ? file.path
      : (renamedFrom.get(file.path) ?? file.path);
    const sha = reviewedAt.get(reviewedPath);
    const base = sha === undefined ? undefined : baselines.get(sha);
    if (reviewedPath !== file.path) handled.add(reviewedPath);
    if (sha === undefined || base === undefined) {
      // Never reviewed, or its last reviewed commit is gone: the whole PR diff.
      if (sha !== undefined) gone.push(file.path);
      plan(file);
      continue;
    }
    compared = true;
    const moved = sinceBaseline(file, base, reviewedPath);
    if (moved === undefined) cover(file.path, reviewedPath);
    else plan(moved);
    // The old name is covered too: nothing is left there to review.
    if (reviewedPath !== file.path) cover(reviewedPath);
  }
  const inPr = new Set(files.map((file) => file.path));

  // Files the PR changed at their last review but no longer changes at all (fully reverted).
  const reverted: { before: FileDiff; removed: string[] }[] = [];
  for (const [sha, base] of baselines) {
    if (base === undefined) continue;
    for (const before of base.previousFiles) {
      if (reviewedAt.get(before.path) !== sha || handled.has(before.path)) continue;
      const movedTo = base.movedAway.get(before.path);
      if (movedTo !== undefined && inPr.has(movedTo)) continue;
      compared = true;
      const removed = before.status === "deleted" ? [] : removedTexts(before, undefined);
      if (removed.length > 0) reverted.push({ before, removed });
      else cover(before.path);
    }
  }
  // Their blobs are the ones at head (the same as at the merge base), not the last review's,
  // which the file no longer has.
  const atHead = await blobsAt(
    repo,
    repo.headSha,
    reverted.flatMap(({ before }) =>
      before.oldPath === undefined ? [before.path] : [before.path, before.oldPath],
    ),
  );
  for (const { before, removed } of reverted) {
    // A reverted rename is back at its old path.
    const path = atHead.has(before.path) ? before.path : before.oldPath;
    const blob = path === undefined ? undefined : atHead.get(path);
    cover(before.path);
    // Added by the PR and dropped again: no file, nothing to review; covered at this head. A
    // path something else already planned or covered isn't listed twice.
    if (path === undefined || blob === undefined || inPr.has(path)) continue;
    if (path !== before.path && handled.has(path)) continue;
    const rest: FileDiff = { ...before };
    delete rest.oldPath;
    plan({
      ...rest,
      path,
      status: "modified",
      oldBlob: blob,
      newBlob: blob,
      moved: false,
      mechanical: false,
      hunks: [],
      changedSinceLastReview: [],
      removedSinceLastReview: removed,
    });
  }
  // Records for paths the PR doesn't change, and that weren't in their baseline's diff either
  // (or whose baseline is gone): nothing to review, covered at this head, so a gone commit isn't
  // asked for again.
  for (const path of reviewedAt.keys()) {
    if (!handled.has(path) && !inPr.has(path)) cover(path);
  }

  for (const path of unchanged.keys()) {
    if (planned.has(path)) throw new Error(`${path} is both planned and covered.`);
  }
  return {
    ...result,
    kind: compared ? "incremental" : "full",
    files: [...planned.values()],
    unchanged: [...unchanged].map(([path, reviewedAs]) => ({ path, reviewedAs })),
    ...(gone.length > 0
      ? {
          fallbackReason: `The commit ${gone.length === 1 ? `${gone[0] ?? ""} was` : `${gone.length} files were`} last reviewed at is no longer in the repository (force-pushed away), so ${gone.length === 1 ? "it is" : "they are"} reviewed in full.`,
        }
      : {}),
  };
}
