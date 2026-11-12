/**
 * Fails if src/schema.ts has changes that no committed migration covers.
 *
 * Copies migrations/ to a temporary folder, runs `drizzle-kit generate` against the copy, and
 * compares the result with the original. Only the schema decides the outcome: uncommitted edits
 * elsewhere don't matter, and it works outside a git checkout.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(packageDir, "migrations");

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

const scratch = mkdtempSync(join(tmpdir(), "lgtmoose-migrations-"));
try {
  cpSync(migrationsDir, scratch, { recursive: true });
  execFileSync(
    "drizzle-kit",
    // drizzle-kit resolves --out relative to the working directory, even for absolute paths.
    [
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      "./src/schema.ts",
      "--out",
      relative(packageDir, scratch),
    ],
    { cwd: packageDir, stdio: "inherit" },
  );

  const before = files(migrationsDir);
  const after = files(scratch);
  const changed = [...after.keys()].filter((name) => before.get(name) !== after.get(name));
  if (changed.length > 0) {
    console.error(
      `The schema has changes no migration covers. Run \`pnpm --filter @lgtmoose/db generate\` ` +
        `and commit the result.\nWould change: ${changed.join(", ")}`,
    );
    process.exitCode = 1;
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
