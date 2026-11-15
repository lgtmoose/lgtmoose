import { describe, expect, it } from "vitest";
import { migrationsDir } from "./drizzle-scratch.js";
import {
  ROOT_SNAPSHOT_ID,
  checkMigrationChain,
  nextMigrationNumber,
  readMigrationFolder,
  snapshotFile,
  type MigrationFolder,
} from "./migration-chain.js";

/** A folder of migrations with these numbers and names, chained and dated in order. */
function folder(numbers: readonly number[]): MigrationFolder & {
  snapshots: Map<string, { id: string; prevId: string }>;
} {
  const sqlFiles = numbers.map((n) => `${String(n).padStart(4, "0")}_step-${n}.sql`);
  const journal = sqlFiles.map((file, idx) => ({
    idx,
    when: 1000 + idx,
    tag: file.slice(0, -".sql".length),
  }));
  const snapshots = new Map<string, { id: string; prevId: string }>();
  let prevId = ROOT_SNAPSHOT_ID;
  for (const n of numbers) {
    const id = `id-${n}`;
    snapshots.set(snapshotFile(n), { id, prevId });
    prevId = id;
  }
  return { sqlFiles, journal, snapshots };
}

describe("checkMigrationChain", () => {
  it("accepts a folder numbered one after another, chained and dated in order", () => {
    expect(checkMigrationChain(folder([0, 1, 2, 3]), new Set())).toEqual([]);
  });

  it("accepts the documented gap at 0003", () => {
    expect(checkMigrationChain(folder([0, 1, 2, 4, 5]))).toEqual([]);
  });

  it("refuses a gap that isn't documented", () => {
    expect(checkMigrationChain(folder([0, 1, 2, 4, 6]))).toEqual([
      "0006_step-6.sql should be numbered 0005: migrations are numbered one after another.",
    ]);
  });

  it("refuses a number listed as never used", () => {
    expect(checkMigrationChain(folder([0, 1, 2, 3]))).toContain(
      "0003_step-3.sql uses 0003, which is listed as never used (SKIPPED_NUMBERS).",
    );
  });

  it("refuses two files with one number, as two branches each adding one would", () => {
    const twice = folder([0, 1, 2]);
    twice.sqlFiles = [...twice.sqlFiles, "0002_other.sql"];
    expect(checkMigrationChain(twice, new Set())).toContain(
      "0002_other.sql and 0002_step-2.sql share the number 0002.",
    );
  });

  it("refuses a snapshot that doesn't chain to the one before", () => {
    const broken = folder([0, 1, 2]);
    broken.snapshots.set(snapshotFile(2), { id: "id-2", prevId: "id-0" });
    expect(checkMigrationChain(broken, new Set())).toEqual([
      "meta/0002_snapshot.json's prevId is id-0, but meta/0001_snapshot.json's id is id-1.",
    ]);
  });

  it("refuses a missing snapshot or one with no migration", () => {
    const missing = folder([0, 1]);
    missing.snapshots.delete(snapshotFile(1));
    missing.snapshots.set(snapshotFile(7), { id: "x", prevId: "y" });
    expect(checkMigrationChain(missing, new Set())).toEqual([
      "meta/0001_snapshot.json is missing.",
      "meta/0007_snapshot.json has no migration.",
    ]);
  });

  it("refuses a journal that doesn't match the files", () => {
    const mismatch = folder([0, 1]);
    mismatch.journal = mismatch.journal.map((entry) =>
      entry.idx === 1 ? { ...entry, tag: "0001_renamed" } : entry,
    );
    expect(checkMigrationChain(mismatch, new Set())).toEqual([
      "Journal entry 1 is tagged 0001_renamed, but migration 1 is 0001_step-1.sql.",
    ]);
  });

  it("refuses a journal entry dated no later than the one before", () => {
    const early = folder([0, 1]);
    early.journal = early.journal.map((entry) =>
      entry.idx === 1 ? { ...entry, when: 1000 } : entry,
    );
    expect(checkMigrationChain(early, new Set())).toEqual([
      "0001_step-1 is dated no later than 0000_step-0, so it would be skipped.",
    ]);
  });

  it("refuses a missing journal entry and a misnamed file", () => {
    const short = folder([0, 1]);
    short.journal = short.journal.slice(0, 1);
    short.sqlFiles = [...short.sqlFiles, "notes.sql"];
    expect(checkMigrationChain(short, new Set())).toEqual([
      "notes.sql isn't named NNNN_name.sql.",
      "The journal has 1 entries for 2 migration files.",
    ]);
  });
});

describe("nextMigrationNumber", () => {
  it("is one after the highest file, never a skipped number", () => {
    expect(nextMigrationNumber(["0000_a.sql", "0001_b.sql", "0002_c.sql"])).toBe(4);
    expect(nextMigrationNumber(["0014_a.sql", "0015_b.sql"])).toBe(16);
    expect(nextMigrationNumber([])).toBe(0);
  });
});

describe("the committed migrations folder", () => {
  it("follows the rules", () => {
    expect(checkMigrationChain(readMigrationFolder(migrationsDir))).toEqual([]);
  });
});
