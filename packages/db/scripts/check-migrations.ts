/**
 * Fails when the migrations folder is out of order, or when src/schema.ts has changes that no
 * committed migration covers.
 *
 * 1. The folder: numbers one after another, the journal matching the files and dated in order,
 *    and the snapshots chained (`checkMigrationChain`).
 * 2. The schema: runs `drizzle-kit generate` against a scratch copy of migrations/ and compares
 *    the result with the original. Only the schema decides: uncommitted edits elsewhere don't
 *    matter, and it works outside a git checkout.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { migrationsDir, withDrizzleGenerate } from "./drizzle-scratch.js";
import { checkMigrationChain, readMigrationFolder } from "./migration-chain.js";

/** A clean check takes a few seconds; anything longer means drizzle-kit is stuck. */
const TIMEOUT_MS = 120_000;

function files(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(dir, path), readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return out;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

const problems = checkMigrationChain(readMigrationFolder(migrationsDir));
if (problems.length > 0) {
  fail(
    [
      "The migrations folder is out of order:",
      ...problems.map((problem) => `- ${problem}`),
      "See packages/db/README.md for how to add a migration.",
    ].join("\n"),
  );
}

withDrizzleGenerate(
  // No stdin: if drizzle-kit needs to ask whether something was renamed, it can't wait for an
  // answer that never comes. A prompt means the schema changed, which is drift.
  { stdio: ["ignore", "pipe", "pipe"], timeoutMs: TIMEOUT_MS },
  (run) => {
    process.stdout.write(run.output.trim() === "" ? "" : `${run.output.trim()}\n`);
    // drizzle-kit prints some failures, such as a rename prompt with no TTY, and still exits 0.
    const printedError = /^Error\b/m.test(run.output);
    const generate = "Run `pnpm --filter @lgtmoose/db generate --name <name>` and commit it.";
    if (run.error || run.status !== 0 || printedError) {
      let reason = run.error?.message ?? `exited with ${run.status}`;
      if (run.signal === "SIGTERM") reason = `timed out after ${TIMEOUT_MS / 1000}s`;
      else if (printedError && run.status === 0) reason = "printed an error";
      fail(
        `drizzle-kit generate ${reason}. It usually does this when the schema changed in a way ` +
          `it needs to ask about, such as a rename.\n${generate}`,
      );
      return;
    }
    const before = files(migrationsDir);
    const after = files(run.out);
    const changed = [...after.keys()].filter((name) => before.get(name) !== after.get(name));
    if (changed.length > 0) {
      fail(
        `The schema has changes no migration covers.\nWould change: ${changed.join(", ")}\n${generate}`,
      );
    }
  },
);
