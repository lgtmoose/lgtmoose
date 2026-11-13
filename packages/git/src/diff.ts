import type { Repo } from "./clone.js";
import { importLines } from "./imports.js";
import { parsePatch, type FilePatch, type Hunk } from "./patch.js";

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface FileDiff {
  /** Path at head; for deleted files, the path at the base. */
  path: string;
  /** Path at the base, when it differs (renames and copies). */
  oldPath?: string;
  status: FileStatus;
  oldBlob: string | undefined;
  newBlob: string | undefined;
  /** Renamed or copied with identical contents (same blob). Nothing to review in it. */
  moved: boolean;
  /**
   * Every changed line is part of an import statement or blank: an import-only edit, such as
   * the knock-on of a move. Worth a glance, not a review.
   */
  mechanical: boolean;
  binary: boolean;
  hunks: Hunk[];
  /**
   * Incremental reviews only: the head-side lines added by the PR that changed since the last
   * reviewed commit. Hunks still describe the whole PR diff, since review comments must sit on
   * lines GitHub shows in the PR.
   */
  changedSinceLastReview?: number[];
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
  C: "copied",
  T: "type-changed",
};

interface RawEntry {
  status: FileStatus;
  oldBlob: string | undefined;
  newBlob: string | undefined;
  oldPath: string;
  newPath: string;
}

const ZERO_SHA = /^0+$/;

/** Parses `git diff --raw -z`: blob SHAs and statuses, with paths that need no unquoting. */
function parseRaw(text: string): RawEntry[] {
  const fields = text.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < fields.length;) {
    const meta = fields[i++];
    if (!meta?.startsWith(":")) continue;
    const [, , oldBlob = "", newBlob = "", code = ""] = meta.slice(1).split(" ");
    const letter = code[0] ?? "M";
    const oldPath = fields[i++] ?? "";
    const newPath = letter === "R" || letter === "C" ? (fields[i++] ?? "") : oldPath;
    entries.push({
      status: STATUS[letter] ?? "modified",
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
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

async function blobText(repo: Repo, blob: string | undefined): Promise<string> {
  return blob === undefined ? "" : repo.git(["cat-file", "blob", blob]);
}

async function isMechanical(repo: Repo, raw: RawEntry, patch: FilePatch): Promise<boolean> {
  const changed = patch.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "context"));
  if (patch.binary || changed.length === 0) return false;
  const [oldText, newText] = await Promise.all([
    blobText(repo, raw.oldBlob),
    blobText(repo, raw.newBlob),
  ]);
  const oldImports = importLines(raw.oldPath, oldText);
  const newImports = importLines(raw.newPath, newText);
  return changed.every((line) => {
    if (line.text.trim() === "") return true;
    return line.kind === "add"
      ? newImports.has(line.newLine ?? 0)
      : oldImports.has(line.oldLine ?? 0);
  });
}

/** Every file the range `from..to` changes, with hunks and blob SHAs. */
async function diffRange(repo: Repo, from: string, to: string): Promise<FileDiff[]> {
  const [raw, patch] = await Promise.all([
    repo.git([...DIFF_FLAGS, "--raw", "-z", from, to]),
    repo.git([...DIFF_FLAGS, "--unified=3", from, to]),
  ]);
  const patches = new Map<string, FilePatch>();
  for (const file of parsePatch(patch)) patches.set(file.newPath ?? file.oldPath ?? "", file);

  return Promise.all(
    parseRaw(raw).map(async (entry) => {
      const key = entry.status === "deleted" ? entry.oldPath : entry.newPath;
      const filePatch = patches.get(key) ?? {
        oldPath: entry.oldPath,
        newPath: entry.newPath,
        binary: false,
        hunks: [],
      };
      const moved =
        (entry.status === "renamed" || entry.status === "copied") &&
        entry.oldBlob !== undefined &&
        entry.oldBlob === entry.newBlob;
      return {
        path: key,
        ...(entry.oldPath !== key ? { oldPath: entry.oldPath } : {}),
        status: entry.status,
        oldBlob: entry.oldBlob,
        newBlob: entry.newBlob,
        moved,
        mechanical: moved ? false : await isMechanical(repo, entry, filePatch),
        binary: filePatch.binary,
        hunks: filePatch.hunks,
      } satisfies FileDiff;
    }),
  );
}

/** Head-side line numbers each file's diff adds. */
function addedLines(file: FileDiff): Set<number> {
  return new Set(
    file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.newLine ?? 0)),
  );
}

/**
 * The diff to review.
 *
 * A first review covers `base...head`: everything from the merge base to head, which leaves out
 * whatever the base branch did meanwhile.
 *
 * An incremental review keeps the same PR diff, but only the files where lines the PR adds have
 * changed since `lastReviewed`. It intersects the PR's added lines with what changed between
 * the two commits, so changes that arrived by merging the base branch into the PR (which aren't
 * part of the PR diff) and the base-branch changes a rebase brings in drop out. If the last
 * reviewed commit is gone (force-pushed away and collected), it falls back to a full review.
 */
export async function reviewDiff(repo: Repo, options: DiffOptions): Promise<ReviewDiff> {
  const mergeBase = (await repo.git(["merge-base", options.baseSha, repo.headSha])).trim();
  const files = await diffRange(repo, mergeBase, repo.headSha);
  const full: ReviewDiff = { kind: "full", mergeBase, headSha: repo.headSha, files };

  const lastReviewed = options.lastReviewed;
  if (lastReviewed === undefined) return full;
  if (lastReviewed === repo.headSha) {
    return { ...full, kind: "incremental", lastReviewed, files: [] };
  }
  if (!(await repo.hasCommit(lastReviewed))) {
    return {
      ...full,
      fallbackReason: `The last reviewed commit ${lastReviewed.slice(0, 12)} is no longer in the repository (force-pushed away), so this is a full review.`,
    };
  }

  const since = new Map<string, FileDiff>();
  for (const file of await diffRange(repo, lastReviewed, repo.headSha)) since.set(file.path, file);

  const incremental: FileDiff[] = [];
  for (const file of files) {
    const changed = since.get(file.path);
    if (changed === undefined) continue;
    if (file.status === "deleted") {
      // Deleted since the last review (it still existed then).
      if (changed.status === "deleted") incremental.push({ ...file, changedSinceLastReview: [] });
      continue;
    }
    const prLines = addedLines(file);
    const newLines = [...addedLines(changed)]
      .filter((line) => prLines.has(line))
      .sort((a, b) => a - b);
    const renamedSince = changed.status === "renamed" && file.status === "renamed";
    if (newLines.length > 0 || renamedSince) {
      incremental.push({ ...file, changedSinceLastReview: newLines });
    }
  }
  return {
    kind: "incremental",
    mergeBase,
    headSha: repo.headSha,
    lastReviewed,
    files: incremental,
  };
}
