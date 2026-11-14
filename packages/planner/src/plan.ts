import { createHash } from "node:crypto";
import type { RepoConfig } from "@lgtmoose/config";
import { REMOVED_LINES_SHOWN, readingDepth, type FileDiff, type ReadingDepth } from "@lgtmoose/git";
import {
  DEFAULT_SKIP,
  TEST_GLOBS,
  globMatcher,
  skipClassifier,
  type FileHeaders,
  type Skip,
  type SkipReason,
} from "./classify.js";
import { BINARY_LOCKFILE_NOTE, lockfileNotes } from "./lockfile.js";

// How closely to read a file: one rule, in @lgtmoose/git, which the incremental diff uses too.
export { readingDepth, type ReadingDepth } from "@lgtmoose/git";

/** Tiers 1 to 7 come from `tiers` globs; 1 is read first. */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | typeof OTHER_TIER | typeof TEST_TIER;

/** Files no `tiers` glob matches: "everything else". */
export const OTHER_TIER = 8;
/** Test files, always last. */
export const TEST_TIER = 9;

export const DEFAULT_MAX_FILES = 10;

/**
 * Fewer added files than this in one folder, skipped by a vendored, build-output, generated or
 * minified path, are reviewed, not skipped.
 * Source maps and licence files don't count, so they can't pad a folder past the limit.
 */
export const BULK_ADDED_FILES = 5;

/** Skip globs for files that don't run: an added snapshot is never hidden code. */
const INERT_GLOBS = new Set(["**/__snapshots__/**", "**/*.snap"]);

/**
 * Whether a skip is by a path the PR controls and the file can hold code that runs: vendored
 * and build folders, generated and minified file names. A file the PR adds this way could be
 * hand-written code hidden from review, so a few of them are reviewed.
 */
function isCodePathSkip(skip: Skip | undefined): boolean {
  if (skip === undefined || skip.glob === undefined) return false;
  if (skip.reason === "generated" || skip.reason === "minified") return !INERT_GLOBS.has(skip.glob);
  return skip.reason === "vendored" || skip.reason === "build-output";
}

/** Folder names the vendored and build-output globs skip. */
const SKIPPED_FOLDERS = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "third_party",
  "third-party",
  "node_modules",
  "bower_components",
  "Pods",
  ".yarn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "cdk.out",
  "__pycache__",
]);

/** The vendored or build folder a path is in (`vendor`, `packages/x/dist`), else its folder. */
function skippedFolderOf(path: string): string {
  const parts = path.split("/");
  const at = parts.findIndex((part, i) => i < parts.length - 1 && SKIPPED_FOLDERS.has(part));
  return parts.slice(0, at === -1 ? parts.length - 1 : at + 1).join("/");
}

/** Files that come with vendored code and can't run: they don't count towards a bulk add. */
function isFiller(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".map") || /^(licen[cs]e|copying|notice|authors|readme)(\.|$)/i.test(name);
}
export const DEFAULT_MAX_LINES = 1500;

export interface PlannedFile {
  file: FileDiff;
  depth: ReadingDepth;
  tier: Tier;
  /**
   * Added plus deleted lines in the file's hunks: how much diff the prompt shows for it. On an
   * incremental review the hunks still cover the whole PR, so this is the PR's diff of the file,
   * not just what changed since the last review.
   */
  changedLines: number;
  /** Position in the plan's fixed order, from 0. */
  index: number;
}

export interface SkippedFile {
  file: FileDiff;
  reason: SkipReason;
  /**
   * Added by this PR under a vendored, build, generated or minified path, and skipped only
   * because the PR adds many such files in that folder. It's new code nobody reviewed; say so in the review summary.
   */
  newCode?: true;
  /**
   * For a lockfile: suspicious changes to put in the review summary, such as a package now
   * resolved from an unknown host (see `lockfileNotes`). Missing when there are none.
   */
  notes?: string[];
  /** The glob that matched, for glob-based reasons. */
  glob?: string;
}

export interface Batch {
  /** Position in the plan's batch order, from 0. */
  index: number;
  files: PlannedFile[];
  changedLines: number;
}

export interface Plan {
  /** Files to review, in tier then path order. */
  files: PlannedFile[];
  /** Skipped files, in path order. */
  skipped: SkippedFile[];
  batches: Batch[];
  /** Same input and limits give the same fingerprint, so a checkpoint can be checked before use. */
  fingerprint: string;
}

export interface PlanOptions {
  /** Most files in one batch. */
  maxFiles?: number;
  /** Most changed lines in one batch. A file this big or bigger is a batch of its own. */
  maxLines?: number;
  /** File headers by blob ID, from `readHeaders`, for generated detection. */
  headers?: FileHeaders;
}

/** Where a later run picks up: the next batch to review in the plan with this fingerprint. */
export interface Checkpoint {
  fingerprint: string;
  nextBatch: number;
}

/** Path order by UTF-16 code units, so it doesn't depend on the locale. */
const byPath = (a: string, b: string) => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * How many diff lines a file puts into the prompt, which is what batches are sized by. A file
 * the PR no longer changes at all (no hunks) still lists lines removed since the last review.
 */
export function changedLines(file: FileDiff): number {
  // Lines removed since the last review are in the prompt too, up to the shown limit.
  const removed = file.removedSinceLastReview?.length ?? 0;
  let count = Math.min(removed, REMOVED_LINES_SHOWN) + (removed > REMOVED_LINES_SHOWN ? 1 : 0);
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) if (line.kind !== "context") count += 1;
  }
  return count;
}

/** Builds the tier lookup. A file in several tiers takes the most important one. */
export function tierClassifier(tiers: RepoConfig["tiers"]): (path: string) => Tier {
  const ordered = Object.entries(tiers)
    .map(([key, globs]) => ({ tier: Number(key) as Tier, match: globMatcher(globs) }))
    .sort((a, b) => a.tier - b.tier);
  const isTest = globMatcher(TEST_GLOBS);
  return (path) => {
    if (isTest(path) !== undefined) return TEST_TIER;
    return ordered.find(({ match }) => match(path) !== undefined)?.tier ?? OTHER_TIER;
  };
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/** Groups files in order. A batch closes when the next file would pass either limit. */
export function toBatches(files: PlannedFile[], maxFiles: number, maxLines: number): Batch[] {
  const batches: Batch[] = [];
  let current: PlannedFile[] = [];
  let lines = 0;
  const close = () => {
    if (current.length === 0) return;
    batches.push({ index: batches.length, files: current, changedLines: lines });
    current = [];
    lines = 0;
  };
  for (const file of files) {
    if (file.changedLines >= maxLines) {
      close();
      current = [file];
      lines = file.changedLines;
      close();
      continue;
    }
    if (current.length >= maxFiles || lines + file.changedLines > maxLines) close();
    current.push(file);
    lines += file.changedLines;
  }
  close();
  return batches;
}

function fingerprintOf(files: PlannedFile[], maxFiles: number, maxLines: number): string {
  const key = files.map(({ file, depth, tier, changedLines: lines }) => [
    file.path,
    file.oldPath ?? null,
    file.status,
    file.oldBlob ?? null,
    file.newBlob ?? null,
    depth,
    tier,
    lines,
  ]);
  return createHash("sha256")
    .update(JSON.stringify({ maxFiles, maxLines, files: key }))
    .digest("hex");
}

/**
 * Works out what to review and in what order, without a model call. Skips files nobody should
 * read, sorts the rest by tier then path, and cuts them into batches.
 *
 * `config` must be read from the base commit, not the PR's head: the PR could otherwise edit
 * `.lgtmoose.yaml` to skip its own files. Skipped files are returned so the review can list them.
 */
export function planReview(
  diff: readonly FileDiff[],
  config: Pick<RepoConfig, "skip" | "tiers"> & Partial<Pick<RepoConfig, "registries" | "include">>,
  options: PlanOptions = {},
): Plan {
  const maxFiles = positiveInteger("maxFiles", options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxLines = positiveInteger("maxLines", options.maxLines ?? DEFAULT_MAX_LINES);
  const skipOf = skipClassifier(config.skip, {
    headers: options.headers,
    include: config.include,
  });
  const trustedHosts = config.registries ?? [];
  // bun.lockb and the like: skipped as binary first, but still a lockfile change to mention.
  const isLockfilePath = globMatcher(DEFAULT_SKIP.lockfile);
  const notesFor = (file: FileDiff, skip: Skip): string[] => {
    if (skip.reason === "lockfile") return lockfileNotes(file, { trustedHosts });
    if (skip.reason === "binary" && isLockfilePath(file.path) !== undefined) {
      return [BINARY_LOCKFILE_NOTE];
    }
    return [];
  };
  const tierOf = tierClassifier(config.tiers);

  const skips = diff.map((file) => skipOf(file));
  // Real vendoring or committed build output adds many files at once. A handful of new files in
  // vendor/ or build/ could be hand-written code hidden there, so those are reviewed.
  const addedPerFolder = new Map<string, number>();
  for (const [i, file] of diff.entries()) {
    if (file.status !== "added" || !isCodePathSkip(skips[i]) || isFiller(file.path)) continue;
    const folder = skippedFolderOf(file.path);
    addedPerFolder.set(folder, (addedPerFolder.get(folder) ?? 0) + 1);
  }
  const isNewFolderCode = (file: FileDiff, skip: Skip | undefined) =>
    file.status === "added" && isCodePathSkip(skip);
  const isBulk = (file: FileDiff) =>
    (addedPerFolder.get(skippedFolderOf(file.path)) ?? 0) >= BULK_ADDED_FILES;

  const skipped: SkippedFile[] = [];
  const kept: Omit<PlannedFile, "index">[] = [];
  for (const [i, file] of diff.entries()) {
    const found = skips[i];
    const newCode = isNewFolderCode(file, found);
    const skip = newCode && !isBulk(file) ? undefined : found;
    if (skip !== undefined) {
      const notes = notesFor(file, skip);
      skipped.push({
        file,
        ...skip,
        ...(newCode ? { newCode: true as const } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      });
      continue;
    }
    kept.push({
      file,
      depth: readingDepth(file),
      tier: tierOf(file.path),
      changedLines: changedLines(file),
    });
  }

  const files = kept
    .sort((a, b) => a.tier - b.tier || byPath(a.file.path, b.file.path))
    .map((planned, index) => ({ ...planned, index }));
  skipped.sort((a, b) => byPath(a.file.path, b.file.path));

  return {
    files,
    skipped,
    batches: toBatches(files, maxFiles, maxLines),
    fingerprint: fingerprintOf(files, maxFiles, maxLines),
  };
}

/** The checkpoint to save once batches up to and including `done` are reviewed. */
export function checkpointAfter(plan: Plan, done: number): Checkpoint {
  return { fingerprint: plan.fingerprint, nextBatch: done + 1 };
}

/**
 * Batches still to review. A checkpoint from a different plan (new commits, changed config)
 * doesn't apply, so every batch is returned.
 */
export function remainingBatches(plan: Plan, checkpoint?: Checkpoint): Batch[] {
  if (checkpoint?.fingerprint !== plan.fingerprint) return plan.batches;
  return plan.batches.slice(Math.max(0, checkpoint.nextBatch));
}
