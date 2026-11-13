import { createHash } from "node:crypto";
import type { RepoConfig } from "@lgtmoose/config";
import type { FileDiff } from "@lgtmoose/git";
import {
  TEST_GLOBS,
  globMatcher,
  skipClassifier,
  type FileHeaders,
  type SkipReason,
} from "./classify.js";

/** How closely to read a file. "move" and "mechanical" files only need a glance. */
export type ReadingDepth = "full" | "move" | "mechanical";

/** Tiers 1 to 7 come from `tiers` globs; 1 is read first. */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | typeof OTHER_TIER | typeof TEST_TIER;

/** Files no `tiers` glob matches: "everything else". */
export const OTHER_TIER = 8;
/** Test files, always last. */
export const TEST_TIER = 9;

export const DEFAULT_MAX_FILES = 10;
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

export function readingDepth(file: FileDiff): ReadingDepth {
  if (file.moved) return "move";
  if (file.mechanical) return "mechanical";
  return "full";
}

/**
 * How many diff lines a file puts into the prompt, which is what batches are sized by. A file
 * the PR no longer changes at all (no hunks) still lists lines removed since the last review.
 */
export function changedLines(file: FileDiff): number {
  if (file.hunks.length === 0) return file.removedSinceLastReview?.length ?? 0;
  let count = 0;
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
  config: Pick<RepoConfig, "skip" | "tiers">,
  options: PlanOptions = {},
): Plan {
  const maxFiles = positiveInteger("maxFiles", options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxLines = positiveInteger("maxLines", options.maxLines ?? DEFAULT_MAX_LINES);
  const skipOf = skipClassifier(config.skip, options.headers);
  const tierOf = tierClassifier(config.tiers);

  const skipped: SkippedFile[] = [];
  const kept: Omit<PlannedFile, "index">[] = [];
  for (const file of diff) {
    const skip = skipOf(file);
    if (skip !== undefined) {
      skipped.push({ file, ...skip });
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
