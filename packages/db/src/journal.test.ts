import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrate.js";

interface Journal {
  entries: { idx: number; when: number; tag: string }[];
}

const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as Journal;

describe("migration journal", () => {
  it("numbers its entries in order", () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index),
    );
  });

  // drizzle's migrator applies only migrations dated after the last one applied, so one dated
  // earlier than its predecessor (say, from a branch merged after another) would be skipped
  // without a word on any database that already has the predecessor.
  it("dates each migration after the one before", () => {
    const out = journal.entries.filter(
      (entry, index) => index > 0 && entry.when <= (journal.entries[index - 1]?.when ?? 0),
    );
    expect(out.map((entry) => entry.tag)).toEqual([]);
  });
});
