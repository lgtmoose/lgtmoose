/**
 * Fails if src/schema.ts has changes that no committed migration covers.
 *
 * Copies migrations/ into a scratch folder inside this package, runs `drizzle-kit generate`
 * against the copy with the real drizzle.config.ts (only `out` overridden), and compares the
 * result with the original. Only the schema decides the outcome: uncommitted edits elsewhere
 * don't matter, and it works outside a git checkout.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(packageDir, "migrations");
// Inside the package, so the path drizzle-kit gets is always a plain relative one (no cross-drive
// paths on Windows) and the scratch config can import drizzle.config.ts directly.
const scratchDir = join(packageDir, ".migrations-check");
const scratchOut = join(scratchDir, "out");
const scratchConfig = join(scratchDir, "drizzle.config.ts");
/** A clean check takes a few seconds; anything longer means drizzle-kit is stuck. */
const TIMEOUT_MS = 120_000;

/** drizzle-kit's CLI isn't in its package exports, so find it next to the package entry. */
function drizzleKitBin(): string {
  const entry = createRequire(import.meta.url).resolve("drizzle-kit");
  return join(dirname(entry), "bin.cjs");
}

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
  console.error(
    `${message}\nRun \`pnpm --filter @lgtmoose/db generate\` and commit the new migration.`,
  );
  process.exitCode = 1;
}

rmSync(scratchDir, { recursive: true, force: true });
mkdirSync(scratchDir, { recursive: true });
try {
  cpSync(migrationsDir, scratchOut, { recursive: true });
  writeFileSync(
    scratchConfig,
    [
      'import base from "../drizzle.config.ts";',
      `export default { ...base, out: "./${relative(packageDir, scratchOut).split("\\").join("/")}" };`,
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    [drizzleKitBin(), "generate", "--config", relative(packageDir, scratchConfig)],
    {
      cwd: packageDir,
      // No stdin: if drizzle-kit needs to ask whether something was renamed, it can't wait for an
      // answer that never comes. A prompt means the schema changed, which is drift.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  // drizzle-kit prints some failures, such as a rename prompt with no TTY, and still exits 0.
  const printedError = /^Error\b/m.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);

  if (result.error || result.status !== 0 || printedError) {
    let reason = result.error?.message ?? `exited with ${result.status}`;
    if (result.signal === "SIGTERM") reason = `timed out after ${TIMEOUT_MS / 1000}s`;
    else if (printedError && result.status === 0) reason = "printed an error";
    fail(
      `drizzle-kit generate ${reason}. It usually does this when the schema changed in a way it ` +
        "needs to ask about, such as a rename.",
    );
  } else {
    const before = files(migrationsDir);
    const after = files(scratchOut);
    const changed = [...after.keys()].filter((name) => before.get(name) !== after.get(name));
    if (changed.length > 0) {
      fail(`The schema has changes no migration covers.\nWould change: ${changed.join(", ")}`);
    }
  }
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
