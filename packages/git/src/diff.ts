import type { Repo } from "./clone.js";
import { importLines, languageOf } from "./imports.js";
import { parsePatch, type FilePatch, type Hunk } from "./patch.js";

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
  /** Why an incremental review fell back to a full one. */
  fallbackReason?: string;
  files: FileDiff[];
  /**
   * Every file the PR changes against the merge base, whatever the kind: `files` itself for a
   * full review. For what holds approval for the whole PR, such as a lockfile change.
   */
  prFiles: FileDiff[];
}

export interface DiffOptions {
  /** The base branch's head commit. */
  baseSha: string;
  /** The commit reviewed last time. Omit for a first review. */
  lastReviewed?: string;
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
  { detectMechanical = true }: { detectMechanical?: boolean } = {},
): Promise<FileDiff[]> {
  const [raw, patch] = await Promise.all([
    repo.git([...DIFF_FLAGS, "--raw", "-z", from, to]),
    repo.git([...DIFF_FLAGS, "--unified=3", from, to]),
  ]);
  const entries = parseRaw(raw);
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
export function diffCommits(repo: Repo, from: string, to: string): Promise<FileDiff[]> {
  return diffRange(repo, from, to, { detectMechanical: false });
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

/**
 * The diff to review.
 *
 * A first review covers `base...head`: everything from the merge base to head, which leaves out
 * whatever the base branch did meanwhile.
 *
 * An incremental review keeps the same PR diff, but only the files where the PR's own changes
 * moved since `lastReviewed`: lines it adds that changed since then, and lines it added then but
 * no longer does. Both come from comparing the PR's diff, not the commits, so changes that
 * arrived by merging the base branch into the PR, and the base-branch changes a rebase brings,
 * drop out. If the last reviewed commit is gone (force-pushed away and collected), it falls back
 * to a full review.
 */
export async function reviewDiff(repo: Repo, options: DiffOptions): Promise<ReviewDiff> {
  const mergeBase = (await repo.git(["merge-base", options.baseSha, repo.headSha])).trim();
  const lastReviewed = options.lastReviewed;
  const files = await diffRange(repo, mergeBase, repo.headSha);
  if (lastReviewed === repo.headSha) {
    return {
      kind: "incremental",
      mergeBase,
      headSha: repo.headSha,
      lastReviewed,
      files: [],
      prFiles: files,
    };
  }
  const full: ReviewDiff = {
    kind: "full",
    mergeBase,
    headSha: repo.headSha,
    files,
    prFiles: files,
  };
  if (lastReviewed === undefined) return full;
  if (!(await repo.hasCommit(lastReviewed))) {
    return {
      ...full,
      fallbackReason: `The last reviewed commit ${lastReviewed.slice(0, 12)} is no longer in the repository (force-pushed away), so this is a full review.`,
    };
  }

  // What changed between the two commits, and what the PR's own diff was back then.
  const previousBase = (await repo.git(["merge-base", options.baseSha, lastReviewed])).trim();
  const [sinceFiles, previousFiles] = await Promise.all([
    diffRange(repo, lastReviewed, repo.headSha, { detectMechanical: false }),
    diffRange(repo, previousBase, lastReviewed, { detectMechanical: false }),
  ]);
  const since = new Map(sinceFiles.map((f) => [f.path, f]));
  const previous = new Map(previousFiles.map((f) => [f.path, f]));

  const incremental: FileDiff[] = [];
  const seen = new Set<string>();
  // Renamed since the last review: the previous diff has the file under its old path, even when
  // the current PR diff shows it as a plain addition under the new one.
  for (const moved of sinceFiles) if (moved.oldPath !== undefined) seen.add(moved.oldPath);
  for (const file of files) {
    seen.add(file.path);
    // A file renamed since the last review is under its old path in the previous diff.
    if (file.oldPath !== undefined) seen.add(file.oldPath);
    const changed = since.get(file.path);
    const before = previous.get(file.oldPath ?? file.path) ?? previous.get(file.path);
    const removed = file.status === "deleted" ? [] : removedTexts(before, file, changed);
    if (file.status === "deleted") {
      // Deleted since the last review (it still existed then).
      if (changed?.status === "deleted")
        incremental.push({ ...file, changedSinceLastReview: [], removedSinceLastReview: [] });
      continue;
    }
    const prLines = addedLines(file);
    const newLines = changed
      ? [...addedLines(changed)].filter((line) => prLines.has(line)).sort((a, b) => a - b)
      : [];
    const renamedSince = changed?.status === "renamed" && file.status === "renamed";
    if (newLines.length > 0 || removed.length > 0 || renamedSince) {
      incremental.push({
        ...file,
        changedSinceLastReview: newLines,
        removedSinceLastReview: removed,
      });
    }
  }
  // Files the PR changed at the last review but no longer changes at all (fully reverted).
  for (const before of previousFiles) {
    if (seen.has(before.path) || before.status === "deleted") continue;
    const removed = removedTexts(before, undefined);
    if (removed.length > 0) {
      incremental.push({
        ...before,
        hunks: [],
        changedSinceLastReview: [],
        removedSinceLastReview: removed,
      });
    }
  }
  return {
    kind: "incremental",
    mergeBase,
    headSha: repo.headSha,
    lastReviewed,
    files: incremental,
    prFiles: files,
  };
}
