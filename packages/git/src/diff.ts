import type { Repo } from "./clone.js";
import { importLines, languageOf } from "./imports.js";
import { parsePatch, type FilePatch, type Hunk } from "./patch.js";
import { pool } from "./pool.js";

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
  /**
   * Incremental reviews only: other names this file had at its earlier reviews (it was renamed
   * since). Recorded as reviewed together with the file, only once its batch succeeds.
   */
  alsoReviewedAs?: string[];
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
  unchanged: string[];
  /**
   * Incremental reviews only: files the PR changed at an earlier review and no longer changes
   * at all, with the lines it added then and no longer does (a removed check, say). Nothing in
   * them is left to review, so they're reported, not planned.
   */
  noLongerChanged: { path: string; lines: string[] }[];
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
function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Lines whose replacement in the same hunk keeps at least half their words count as reworded. */
const REWORDED = 0.5;

/**
 * Words that mark a guard: a dropped line with one is never taken for a rewording, so a removed
 * check is always shown.
 */
const GUARD = /\b(throw|return|auth\w*|admin\w*|permission\w*|check\w*|verify\w*|require\w*)\b/i;

/**
 * Texts of lines reworded since the review: in `since` (the file's diff from then to now), a
 * deleted line in a hunk that adds a line keeping at least half its words. Lines with a guard
 * word don't count.
 */
function rewordedIn(since: FileDiff | undefined): Set<string> {
  const reworded = new Set<string>();
  for (const hunk of since?.hunks ?? []) {
    const added = hunk.lines.filter((line) => line.kind === "add").map((line) => words(line.text));
    if (added.length === 0) continue;
    for (const line of hunk.lines) {
      if (line.kind !== "del" || GUARD.test(line.text)) continue;
      const own = words(line.text);
      if (added.some((other) => overlap(own, other) >= REWORDED)) reworded.add(line.text);
    }
  }
  return reworded;
}

/**
 * The lines a file's PR change added at an earlier review (`before`) that its PR change now
 * (`current`, undefined when the PR no longer changes it) no longer adds: what a reader should
 * look at, such as a removed check. Trivial lines are left out, and so are rewordings: a line
 * replaced, in the same hunk of `since` (the file's diff from that review to now), by a line
 * keeping half its words, unless it holds a guard word.
 */
export function noLongerAdded(
  before: FileDiff | undefined,
  current: FileDiff | undefined,
  since?: FileDiff,
): string[] {
  const now = addedTexts(current);
  const dropped: [string, number][] = [];
  for (const [text, count] of addedTexts(before)) {
    const kept = now.get(text) ?? 0;
    if (kept < count && !TRIVIAL.test(text)) dropped.push([text, count - kept]);
  }
  if (dropped.length === 0) return [];
  const reworded = rewordedIn(since);
  return dropped.flatMap(([text, n]) =>
    reworded.has(text) ? [] : Array.from({ length: n }, () => text),
  );
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

/**
 * The file with these lines it no longer adds. A file with some can't count as only moved: what
 * it dropped is what's left to read.
 */
function withRemoved(file: FileDiff, removed: readonly string[]): FileDiff {
  if (removed.length === 0) return file;
  return { ...file, moved: false, removedSinceLastReview: [...removed] };
}

/** How many baselines are diffed at once. */
const BASELINES_AT_ONCE = 4;

/**
 * What changed in one file's PR change since its baseline: the file with its incremental
 * notes, or undefined when nothing did (the PR adds the same lines, moved or not, and stopped
 * adding nothing).
 */
function sinceBaseline(file: FileDiff, base: Baseline): FileDiff | undefined {
  const changed = base.since.get(file.path);
  if (file.status === "deleted") {
    // Deleted since the last review (it still existed then).
    return changed?.status === "deleted"
      ? { ...file, changedSinceLastReview: [], removedSinceLastReview: [] }
      : undefined;
  }
  // The PR's diff of the file back then.
  const before = base.previous.get(file.path);
  const removed = noLongerAdded(before, file, changed);
  const prLines = addedLines(file);
  const newLines = changed
    ? [...addedLines(changed)].filter((line) => prLines.has(line)).sort((a, b) => a - b)
    : [];
  if (newLines.length === 0 && removed.length === 0) return undefined;
  return withRemoved({ ...file, changedSinceLastReview: newLines }, removed);
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
  const prFileAt = new Map(files.map((file) => [file.path, file]));
  const { reviewedAt } = options;
  if (reviewedAt === undefined || reviewedAt.size === 0) {
    return { ...result, kind: "full", files, unchanged: [], noLongerChanged: [] };
  }

  // Every baseline commit in use, with what it gives (undefined when it's gone), each diffed
  // only for the paths reviewed there.
  const pathsAt = new Map<string, string[]>();
  for (const [path, sha] of reviewedAt) {
    const paths = pathsAt.get(sha);
    if (paths === undefined) pathsAt.set(sha, [path]);
    else paths.push(path);
  }
  const shas = [...pathsAt.keys()];
  const present = await repo.hasCommits(shas.filter((sha) => sha !== repo.headSha));
  const built = await pool(shas, BASELINES_AT_ONCE, async (sha): Promise<Baseline | undefined> => {
    const paths = pathsAt.get(sha) ?? [];
    if (sha === repo.headSha) {
      // Reviewed at this very head: nothing has changed since.
      const wanted = new Set(paths);
      const same = files.filter((f) => wanted.has(f.path));
      return {
        since: new Map(),
        previous: new Map(same.map((f) => [f.path, f])),
        previousFiles: same,
        movedAway: new Map(),
      };
    }
    return present.has(sha) ? baseline(repo, options.baseSha, sha, paths) : undefined;
  });
  const baselines = new Map(shas.map((sha, i) => [sha, built[i]]));
  const baseOf = (path: string) => {
    const sha = reviewedAt.get(path);
    return sha === undefined ? undefined : baselines.get(sha);
  };
  // Names a file had at its last review, for files renamed since.
  const renamedFrom = new Map<string, string[]>();
  for (const [sha, base] of baselines) {
    for (const [from, to] of base?.movedAway ?? []) {
      if (reviewedAt.get(from) === sha) renamedFrom.set(to, [...(renamedFrom.get(to) ?? []), from]);
    }
  }

  // Each path ends up planned (in `files`) or covered (`unchanged`), never both. Renames are
  // never followed line by line: a file whose names changed since its last record is reviewed
  // in full, and its other names are recorded with it once its batch succeeds.
  const planned = new Map<string, FileDiff>();
  const unchanged = new Set<string>();
  const handled = new Set<string>();
  const plan = (file: FileDiff, otherNames: readonly string[] = []) => {
    const names = [...new Set(otherNames)].filter((name) => name !== file.path);
    planned.set(file.path, names.length > 0 ? { ...file, alsoReviewedAs: names } : file);
    unchanged.delete(file.path);
    handled.add(file.path);
    for (const name of names) {
      unchanged.delete(name);
      handled.add(name);
    }
  };
  const cover = (path: string) => {
    if (!planned.has(path)) unchanged.add(path);
    handled.add(path);
  };
  const gone = new Set<string>();
  for (const file of files) {
    const base = baseOf(file.path);
    // Names involved: ones it was renamed from since a review, and the PR's own rename's
    // old name when that has a record and this name has none (the rename came after it; once
    // both are recorded, the PR's rename is just part of what was reviewed).
    const prRenameIsNew =
      file.oldPath !== undefined && reviewedAt.has(file.oldPath) && !reviewedAt.has(file.path);
    const otherNames = [
      ...(renamedFrom.get(file.path) ?? []),
      ...(prRenameIsNew && file.oldPath !== undefined ? [file.oldPath] : []),
    ];
    const renamedSince = base?.since.get(file.path)?.oldPath !== undefined;
    if (otherNames.length > 0 || renamedSince) {
      // Named in the fallback reason when an earlier review it had is gone.
      const anyGone = [file.path, ...otherNames].some(
        (name) => reviewedAt.has(name) && baseOf(name) === undefined,
      );
      if (anyGone) gone.add(file.path);
      // Still list what it stopped adding since then, from its diff under each earlier name;
      // rewordings drop out against what changed since.
      const removed = [file.path, ...new Set(otherNames)].flatMap((name) =>
        noLongerAdded(baseOf(name)?.previous.get(name), file, baseOf(name)?.since.get(file.path)),
      );
      plan(withRemoved(file, removed), otherNames);
      continue;
    }
    if (base === undefined) {
      // Never reviewed, or its last reviewed commit is gone: the whole PR diff.
      if (reviewedAt.has(file.path)) gone.add(file.path);
      plan(file);
      continue;
    }
    const moved = sinceBaseline(file, base);
    if (moved === undefined) cover(file.path);
    else plan(moved);
  }

  // Recorded names whose file the PR doesn't change under that name any more: reverted, or
  // renamed away. When the file is in the PR under another name (a reverted rename, a
  // rename's target), that file is reviewed in full with its real diff, listing what it no
  // longer adds compared with the old name's change. When the PR no longer changes the file at
  // all, there's nothing to review; what it stopped adding is reported, and the name covered.
  const noLongerChanged: { path: string; lines: string[] }[] = [];
  for (const [sha, base] of baselines) {
    if (base === undefined) continue;
    for (const before of base.previousFiles) {
      if (reviewedAt.get(before.path) !== sha || handled.has(before.path)) continue;
      // A rename's target still in the PR was found by `renamedFrom` above; what's left is a
      // file back at the name it had before a rename the PR made then.
      const current = before.oldPath === undefined ? undefined : prFileAt.get(before.oldPath);
      // A file the PR added and dropped again exists neither at base nor at head: nothing in it
      // to mention. A deletion the PR undid restores the base's file: nothing either.
      const silent =
        current === undefined && (before.status === "added" || before.status === "deleted");
      const dropped = silent
        ? []
        : noLongerAdded(before, current, current && base.since.get(current.path));
      if (current === undefined) {
        if (dropped.length > 0) noLongerChanged.push({ path: before.path, lines: dropped });
        cover(before.path);
        continue;
      }
      const earlier = planned.get(current.path) ?? current;
      const lines = [...new Set([...(earlier.removedSinceLastReview ?? []), ...dropped])];
      plan(withRemoved(earlier, lines), [...(earlier.alsoReviewedAs ?? []), before.path]);
    }
  }
  // Records for paths the PR doesn't change and that weren't in their baseline's diff: nothing
  // to review, covered at this head. That holds whether or not their commit is still here: the
  // PR doesn't change them now (if it renamed one away, the new name is in the PR, planned and
  // carrying the old name). Covering them also stops a gone commit being asked for again.
  for (const path of reviewedAt.keys()) {
    if (!handled.has(path)) cover(path);
  }

  for (const path of unchanged) {
    if (planned.has(path)) throw new Error(`${path} is both planned and covered.`);
  }
  // Everything planned is a file of the PR diff, with its real hunks: no made-up entries.
  for (const path of planned.keys()) {
    if (!prFileAt.has(path)) throw new Error(`${path} is planned but not in the PR diff.`);
  }
  // Named in the fallback reason: files a gone commit sends to a full read (`readingDepth`).
  const readInFull = [...gone].filter((path) => {
    const file = planned.get(path);
    return file !== undefined && readingDepth(file) === "full";
  });
  const anyBaseline = [...baselines.values()].some((base) => base !== undefined);
  return {
    ...result,
    kind: anyBaseline ? "incremental" : "full",
    files: [...planned.values()],
    unchanged: [...unchanged],
    noLongerChanged,
    ...fallback(readInFull),
  };
}

/** Why files that had an earlier review are read in full: their review's commit is gone. */
function fallback(readInFull: readonly string[]): { fallbackReason?: string } {
  if (readInFull.length === 0) return {};
  return {
    fallbackReason:
      readInFull.length === 1
        ? `${readInFull[0] ?? ""} is reviewed in full: the commit it was last reviewed at is no longer in the repository (force-pushed away).`
        : `${readInFull.length} files are reviewed in full: the commits they were last reviewed at are no longer in the repository (force-pushed away).`,
  };
}

/** How closely to read a file. "move" and "mechanical" files only need a glance. */
export type ReadingDepth = "full" | "move" | "mechanical";

/**
 * How closely a file is read. Lines it stopped adding since the last review always need a
 * full read, moved or not.
 */
export function readingDepth(file: FileDiff): ReadingDepth {
  if ((file.removedSinceLastReview?.length ?? 0) > 0) return "full";
  if (file.moved) return "move";
  if (file.mechanical) return "mechanical";
  return "full";
}
