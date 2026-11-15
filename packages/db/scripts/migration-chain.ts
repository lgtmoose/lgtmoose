/**
 * The rules a migrations folder follows, so a new migration can't take a number that's already
 * used, and drizzle's journal, the SQL files and the snapshots never disagree:
 *
 * - SQL files are `NNNN_name.sql`, numbered one after another from 0000, except the numbers in
 *   `SKIPPED_NUMBERS`, which are never used.
 * - The journal has one entry per file, in the same order (`idx` 0, 1, 2…), tagged with the file's
 *   name, each dated after the one before. drizzle applies migrations in journal order and skips
 *   one dated before the last applied, so an out-of-order date would be silently lost.
 * - Each file has `meta/NNNN_snapshot.json`, and each snapshot's `prevId` is the previous
 *   snapshot's `id` (the first's is all zeros). drizzle-kit diffs against the last snapshot, so a
 *   broken chain means the next generated migration is built on the wrong schema.
 *
 * Pure apart from `readMigrationFolder`, so the rules are tested without a folder.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * File numbers that are never used. 0003: a migration renumbered to 0005 before release, when
 * the branch that held it was merged after 0004 (lgtmoose/lgtmoose#37). It was never applied
 * anywhere, and existing files keep their numbers, so the gap stays. Add a number here only for
 * the same reason, and say why.
 */
export const SKIPPED_NUMBERS: ReadonlySet<number> = new Set([3]);

/** The first snapshot's `prevId`. */
export const ROOT_SNAPSHOT_ID = "00000000-0000-0000-0000-000000000000";

/** A migration file's name: four digits, an underscore, then a name. */
export const MIGRATION_FILE = /^(\d{4})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface Snapshot {
  id: string;
  prevId: string;
}

/** What the checks read from a migrations folder. */
export interface MigrationFolder {
  /** File names of the `.sql` files in the folder. */
  sqlFiles: readonly string[];
  /** `meta/_journal.json`'s entries. */
  journal: readonly JournalEntry[];
  /** `meta/*_snapshot.json`, by file name. */
  snapshots: ReadonlyMap<string, Snapshot>;
}

export function pad(number: number): string {
  return number.toFixed(0).padStart(4, "0");
}

export function snapshotFile(number: number): string {
  return `${pad(number)}_snapshot.json`;
}

/** The number a migration file starts with, or undefined when the name doesn't fit. */
export function migrationNumber(file: string): number | undefined {
  const match = MIGRATION_FILE.exec(file);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The number the next migration takes: one after the highest, skipping `skipped`. */
export function nextMigrationNumber(
  sqlFiles: readonly string[],
  skipped: ReadonlySet<number> = SKIPPED_NUMBERS,
): number {
  const numbers = sqlFiles.flatMap((file) => migrationNumber(file) ?? []);
  let next = numbers.length === 0 ? 0 : Math.max(...numbers) + 1;
  while (skipped.has(next)) next += 1;
  return next;
}

/** Everything wrong with the folder, as sentences; empty when it follows the rules. */
export function checkMigrationChain(
  folder: MigrationFolder,
  skipped: ReadonlySet<number> = SKIPPED_NUMBERS,
): string[] {
  const problems: string[] = [];
  const files: { file: string; number: number }[] = [];
  for (const file of folder.sqlFiles) {
    const number = migrationNumber(file);
    if (number === undefined) {
      problems.push(`${file} isn't named NNNN_name.sql.`);
    } else {
      files.push({ file, number });
    }
  }
  files.sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));

  // Numbers: each once, one after another, never a skipped one.
  let expected = 0;
  for (const [i, { file, number }] of files.entries()) {
    const previous = files[i - 1];
    if (previous !== undefined && previous.number === number) {
      problems.push(`${previous.file} and ${file} share the number ${pad(number)}.`);
      continue;
    }
    if (skipped.has(number)) {
      problems.push(
        `${file} uses ${pad(number)}, which is listed as never used (SKIPPED_NUMBERS).`,
      );
    }
    while (skipped.has(expected) && expected !== number) expected += 1;
    if (number !== expected) {
      problems.push(
        `${file} should be numbered ${pad(expected)}: migrations are numbered one after another.`,
      );
    }
    expected = number + 1;
  }

  // The journal: one entry per file, in order, tagged with its name, dated in order.
  const tags = files.map(({ file }) => file.slice(0, -".sql".length));
  if (folder.journal.length !== tags.length) {
    problems.push(
      `The journal has ${folder.journal.length} entries for ${tags.length} migration files.`,
    );
  }
  for (const [i, entry] of folder.journal.entries()) {
    if (entry.idx !== i) problems.push(`Journal entry ${i} (${entry.tag}) has idx ${entry.idx}.`);
    const tag = tags[i];
    if (tag !== undefined && entry.tag !== tag) {
      problems.push(`Journal entry ${i} is tagged ${entry.tag}, but migration ${i} is ${tag}.sql.`);
    }
    const before = folder.journal[i - 1];
    if (before !== undefined && entry.when <= before.when) {
      problems.push(`${entry.tag} is dated no later than ${before.tag}, so it would be skipped.`);
    }
  }

  // Snapshots: one per file, chained.
  const expectedSnapshots = files.map(({ number }) => snapshotFile(number));
  for (const name of expectedSnapshots) {
    if (!folder.snapshots.has(name)) problems.push(`meta/${name} is missing.`);
  }
  for (const name of folder.snapshots.keys()) {
    if (!expectedSnapshots.includes(name)) problems.push(`meta/${name} has no migration.`);
  }
  let previousId = ROOT_SNAPSHOT_ID;
  let previousName = "the start";
  for (const name of expectedSnapshots) {
    const snapshot = folder.snapshots.get(name);
    if (snapshot === undefined) continue;
    if (snapshot.prevId !== previousId) {
      problems.push(
        `meta/${name}'s prevId is ${snapshot.prevId}, but ${previousName}'s id is ${previousId}.`,
      );
    }
    previousId = snapshot.id;
    previousName = `meta/${name}`;
  }
  return problems;
}

/** Reads a migrations folder from disk for `checkMigrationChain`. */
export function readMigrationFolder(dir: string): MigrationFolder {
  const meta = join(dir, "meta");
  const journal = (
    JSON.parse(readFileSync(join(meta, "_journal.json"), "utf8")) as { entries: JournalEntry[] }
  ).entries;
  const snapshots = new Map<string, Snapshot>();
  for (const name of readdirSync(meta)) {
    if (!name.endsWith("_snapshot.json")) continue;
    const { id, prevId } = JSON.parse(readFileSync(join(meta, name), "utf8")) as Snapshot;
    snapshots.set(name, { id, prevId });
  }
  const sqlFiles = readdirSync(dir).filter((name) => name.endsWith(".sql"));
  return { sqlFiles, journal, snapshots };
}
