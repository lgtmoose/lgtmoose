/**
 * `pnpm --filter @lgtmoose/db generate --name <name>`: writes a migration for the changes in
 * src/schema.ts, numbered after the highest existing file.
 *
 * drizzle-kit names a migration after its journal index. Ours are one behind the file numbers
 * (0003 is never used, see SKIPPED_NUMBERS), so run in place it would reuse the latest number and
 * overwrite that migration's snapshot. Its `prefix` option offers only the index, a timestamp or
 * none, so this runs it against a scratch copy (with the prompts it may ask, such as about a
 * rename), then puts the new SQL file and snapshot in migrations/ under the next free number and
 * adds the journal entry with that tag. drizzle-kit diffs against the highest-named snapshot, which
 * is the latest one, so the new snapshot's prevId already chains.
 *
 * Any arguments are passed to `drizzle-kit generate` (`--name`, `--custom`).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir, packageDir, withDrizzleGenerate } from "./drizzle-scratch.js";
import {
  checkMigrationChain,
  nextMigrationNumber,
  pad,
  readMigrationFolder,
  snapshotFile,
  type JournalEntry,
  type Snapshot,
} from "./migration-chain.js";

interface Journal {
  entries: JournalEntry[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function abort(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Thrown inside the scratch run, so its folder is removed before the script exits. */
class Refused extends Error {}

const before = checkMigrationChain(readMigrationFolder(migrationsDir));
if (before.length > 0) {
  abort(
    ["Fix the migrations folder first:", ...before.map((problem) => `- ${problem}`)].join("\n"),
  );
}

const journalPath = join(migrationsDir, "meta", "_journal.json");
const journal = readJson<Journal>(journalPath);
const folder = readMigrationFolder(migrationsDir);
const number = nextMigrationNumber(folder.sqlFiles);
const latest = journal.entries.at(-1);
const latestSnapshot =
  latest === undefined
    ? undefined
    : folder.snapshots.get(snapshotFile(Number(latest.tag.slice(0, 4))));

function refuse(message: string): never {
  throw new Refused(message);
}

const journalText = readFileSync(journalPath, "utf8");
let written: string[] | undefined;
try {
  written = withDrizzleGenerate(
    { args: process.argv.slice(2), stdio: "inherit" },
    (run): string[] | undefined => {
      if (run.error || run.status !== 0) {
        refuse(`drizzle-kit generate ${run.error?.message ?? `exited with ${run.status}`}.`);
      }
      const scratchJournal = readJson<Journal>(join(run.out, "meta", "_journal.json"));
      if (scratchJournal.entries.length === journal.entries.length) return undefined; // No changes.
      const entry = scratchJournal.entries.at(-1);
      if (entry === undefined || scratchJournal.entries.length !== journal.entries.length + 1) {
        refuse("drizzle-kit added more than one journal entry; nothing was written.");
      }
      const [prefix = ""] = entry.tag.split("_");
      const suffix = entry.tag.slice(prefix.length + 1);
      const tag = `${pad(number)}_${suffix}`;
      const snapshot = readJson<Snapshot>(join(run.out, "meta", `${prefix}_snapshot.json`));
      if (snapshot.prevId !== (latestSnapshot?.id ?? snapshot.prevId)) {
        refuse(
          `drizzle-kit built the new snapshot on ${snapshot.prevId}, not the latest snapshot ` +
            `(${latestSnapshot?.id}); nothing was written.`,
        );
      }

      const sqlTarget = join(migrationsDir, `${tag}.sql`);
      const snapshotTarget = join(migrationsDir, "meta", snapshotFile(number));
      for (const target of [sqlTarget, snapshotTarget]) {
        if (existsSync(target)) refuse(`${target} already exists; nothing was written.`);
      }
      copyFileSync(join(run.out, `${entry.tag}.sql`), sqlTarget);
      copyFileSync(join(run.out, "meta", `${prefix}_snapshot.json`), snapshotTarget);
      journal.entries.push({ ...entry, tag });
      writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
      return [sqlTarget, snapshotTarget, journalPath];
    },
  );
} catch (error) {
  if (error instanceof Refused) abort(error.message);
  throw error;
}

if (written === undefined) {
  console.log("No schema changes: no migration written.");
} else {
  // Format the JSON as the rest of the repository is (prettier has no SQL parser).
  const json = written.filter((path) => path.endsWith(".json"));
  const prettier = spawnSync("pnpm", ["exec", "prettier", "--write", ...json], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (prettier.status !== 0) console.warn("prettier didn't run; format the new files yourself.");
  const after = checkMigrationChain(readMigrationFolder(migrationsDir));
  if (after.length > 0) {
    for (const path of written.slice(0, 2)) rmSync(path, { force: true });
    writeFileSync(journalPath, journalText);
    abort(
      [
        "The new migration breaks the folder's rules, so it was removed:",
        ...after.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }
  console.log(`Wrote ${written.slice(0, 2).join(" and ")}.`);
}
