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
   * Incremental reviews only: base lines the PR deletes now and didn't delete at the last
   * review (old-side line numbers, LEFT in the PR diff), such as a check it takes out.
   */
  deletedSinceLastReview?: number[];
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

/** One file a diff changes, without its patch. */
export interface ChangedPath {
  /** Path at `to`; for deleted files, the path at `from`. */
  path: string;
  /** Path at `from`, when it differs (renames). */
  oldPath?: string;
  status: FileStatus;
}

/**
 * The files `from..to` changes, with renames found, from `git diff --raw` alone: no patch and
 * no file contents, so it's cheap however big the diff is.
 */
export async function changedPaths(repo: Repo, from: string, to: string): Promise<ChangedPath[]> {
  const entries = parseRaw(await repo.git([...DIFF_FLAGS, "--raw", "-z", from, to]));
  return entries.map((entry) => {
    const path = keyOf(entry);
    return {
      path,
      ...(entry.oldPath !== path ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
    };
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

/** Lines that say nothing on their own: blank, or only brackets and punctuation. */
const TRIVIAL = /^[\s{}()[\];,.]*$/;

/** Most removed lines listed for one file; the rest are counted ("…and N more"). */
export const REMOVED_LINES_SHOWN = 200;

/** A line's text for comparing: re-indenting or re-spacing it doesn't change what it says. */
const normalised = (text: string) => text.trim().replace(/\s+/g, " ");

/** Copies of each added line, by normalised text, with the first original text seen. */
function addedCopies(file: FileDiff | undefined): Map<string, { text: string; n: number }> {
  const copies = new Map<string, { text: string; n: number }>();
  for (const line of file?.hunks.flatMap((h) => h.lines) ?? []) {
    if (line.kind !== "add") continue;
    const key = normalised(line.text);
    const known = copies.get(key);
    if (known === undefined) copies.set(key, { text: line.text, n: 1 });
    else known.n += 1;
  }
  return copies;
}

/** One earlier PR change of a file under one of its names, and the review commit it's from. */
export interface EarlierChange {
  change: FileDiff | undefined;
  /** The commit the name was reviewed at: two names are the same file only at the same one. */
  reviewedAt: string;
}

/**
 * The lines a file's PR change added at earlier reviews (`before`, one change per name the file
 * had then) that its PR change now (`current`, undefined when the PR no longer changes it) no
 * longer adds: what a reader should look at, such as a removed check. Counted: every copy it
 * added then and doesn't now is listed, with its original text. Lines are compared with their
 * whitespace normalised, so re-indenting one isn't a removal. Separate files the names were at
 * review time add up; two names are one file only when, at the same review commit, one is
 * recorded as the other's rename. A reworded line is listed too; the new wording shows as an
 * added line. Only lines with nothing to read (blank, or brackets and punctuation alone) are
 * left out.
 */
export function noLongerAdded(
  before: readonly EarlierChange[],
  current: FileDiff | undefined,
): string[] {
  const changes = new Set<FileDiff>();
  for (const { change } of before) if (change !== undefined) changes.add(change);
  // A change is the same file as another from the same review commit that it was renamed to.
  const renamedTo = new Set(
    before.flatMap(({ change, reviewedAt }) =>
      change?.oldPath === undefined ? [] : [`${reviewedAt}\0${change.oldPath}`],
    ),
  );
  const then = new Map<string, { text: string; n: number }>();
  for (const { change, reviewedAt } of before) {
    if (change === undefined || !changes.delete(change)) continue;
    if (renamedTo.has(`${reviewedAt}\0${change.path}`)) continue;
    for (const [key, { text, n }] of addedCopies(change)) {
      const known = then.get(key);
      then.set(key, { text: known?.text ?? text, n: (known?.n ?? 0) + n });
    }
  }
  const now = addedCopies(current);
  const removed: string[] = [];
  for (const [key, { text, n }] of then) {
    if (TRIVIAL.test(text)) continue;
    for (let i = now.get(key)?.n ?? 0; i < n; i++) removed.push(text);
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
): Promise<Baseline | undefined> {
  // No history in common with the base (exit 1, no output): nothing to compare with.
  const previousBase = (await repo.git(["merge-base", baseSha, sha], { okExitCodes: [1] })).trim();
  if (previousBase === "") return undefined;
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
 * What the PR's change to a file is, for telling whether it's the one reviewed: its added and
 * deleted lines in order, with whitespace normalised, plus the blobs when there are no lines to
 * compare (binary files, submodules, pure moves). Base-branch changes elsewhere in the file
 * don't change it; a line the PR now adds or deletes, or a base line it deletes that changed,
 * does.
 */
function prChange(file: FileDiff | undefined): string {
  if (file === undefined) return "";
  const lines = file.hunks.flatMap((hunk) =>
    hunk.lines.flatMap((line) =>
      line.kind === "context" ? [] : [`${line.kind === "add" ? "+" : "-"}${normalised(line.text)}`],
    ),
  );
  const blobs = lines.length === 0 || file.binary || file.submodule;
  return [file.status, ...(blobs ? [file.oldBlob ?? "", file.newBlob ?? ""] : []), ...lines].join(
    "\n",
  );
}

/** Copies of each line the PR deletes from the base, by normalised text. */
function deletedCopies(file: FileDiff | undefined): Map<string, number> {
  const copies = new Map<string, number>();
  for (const line of file?.hunks.flatMap((h) => h.lines) ?? []) {
    if (line.kind !== "del") continue;
    const key = normalised(line.text);
    copies.set(key, (copies.get(key) ?? 0) + 1);
  }
  return copies;
}

/**
 * The file with what changed in its PR change since its last review (`base`), or undefined
 * when its PR change is exactly the one reviewed: the same lines added and deleted. Otherwise
 * it's reviewed again, with the lines it adds that changed since, the base lines it now deletes
 * and didn't then, and the lines it added then and no longer does.
 */
function sinceBaseline(file: FileDiff, base: Baseline): FileDiff | undefined {
  const before = base.previous.get(file.path);
  if (before !== undefined && prChange(before) === prChange(file)) return undefined;
  const changed = base.since.get(file.path);
  const removed = noLongerAdded([{ change: before, reviewedAt: "" }], file);
  const prLines = addedLines(file);
  const newLines = changed
    ? [...addedLines(changed)].filter((line) => prLines.has(line)).sort((a, b) => a - b)
    : [];
  // Base lines deleted now beyond the copies deleted then: the later copies are the new ones.
  const then = deletedCopies(before);
  const seen = new Map<string, number>();
  const newlyDeleted: number[] = [];
  for (const line of file.hunks.flatMap((h) => h.lines)) {
    if (line.kind !== "del" || line.oldLine === undefined) continue;
    const key = normalised(line.text);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > (then.get(key) ?? 0)) newlyDeleted.push(line.oldLine);
  }
  return withRemoved(
    { ...file, changedSinceLastReview: newLines, deletedSinceLastReview: newlyDeleted },
    removed,
  );
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
  const pathsAt = new Map(
    [...Map.groupBy(reviewedAt, ([, sha]) => sha)].map(([sha, entries]) => [
      sha,
      entries.map(([path]) => path),
    ]),
  );
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
  /** Each file's PR change at its earlier reviews, one per name, for what it no longer adds. */
  const beforesOf = new Map<string, EarlierChange[]>();
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
      // Still list what it stopped adding since then, across all its earlier names at once.
      const names = [file.path, ...new Set(otherNames)];
      const befores = names.map((name) => ({
        change: baseOf(name)?.previous.get(name),
        reviewedAt: reviewedAt.get(name) ?? "",
      }));
      beforesOf.set(file.path, befores);
      plan(withRemoved(file, noLongerAdded(befores, file)), otherNames);
      continue;
    }
    if (base === undefined) {
      // Never reviewed, or its last reviewed commit is gone: the whole PR diff.
      if (reviewedAt.has(file.path)) gone.add(file.path);
      plan(file);
      continue;
    }
    beforesOf.set(file.path, [
      { change: base.previous.get(file.path), reviewedAt: reviewedAt.get(file.path) ?? "" },
    ]);
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
      if (current === undefined) {
        const dropped = silent
          ? []
          : noLongerAdded([{ change: before, reviewedAt: sha }], undefined);
        if (dropped.length > 0) noLongerChanged.push({ path: before.path, lines: dropped });
        cover(before.path);
        continue;
      }
      // Worked out once for the file across every name it had, not added up per name.
      const befores = [...(beforesOf.get(current.path) ?? []), { change: before, reviewedAt: sha }];
      beforesOf.set(current.path, befores);
      const earlier = planned.get(current.path) ?? current;
      plan(withRemoved(earlier, noLongerAdded(befores, current)), [
        ...(earlier.alsoReviewedAs ?? []),
        before.path,
      ]);
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
    ...fallback(anyBaseline, readInFull),
  };
}

/**
 * Why the review couldn't build on earlier ones: every earlier review's commit is gone, so it
 * couldn't compare at all; or some files are read in full because theirs is.
 */
function fallback(
  anyBaseline: boolean,
  readInFull: readonly string[],
): { fallbackReason?: string } {
  if (!anyBaseline) {
    return {
      fallbackReason:
        "The earlier reviews' commits are no longer in the repository (force-pushed away), so this run couldn't compare incrementally.",
    };
  }
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
