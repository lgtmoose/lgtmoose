/**
 * Runs `drizzle-kit generate` against a scratch copy of migrations/, inside this package, with the
 * real drizzle.config.ts (only `out` overridden). Used by check-migrations.ts (is the schema
 * covered?) and generate.ts (write a migration under the right number).
 *
 * The copy keeps drizzle-kit from touching the real folder: it names a new migration after its
 * journal index, which is one behind our file numbers (SKIPPED_NUMBERS), so in place it would
 * overwrite the latest snapshot.
 */
import { spawnSync, type StdioOptions } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = fileURLToPath(new URL("..", import.meta.url));
export const migrationsDir = join(packageDir, "migrations");
// Inside the package, so the path drizzle-kit gets is always a plain relative one (no cross-drive
// paths on Windows) and the scratch config can import drizzle.config.ts directly.
const scratchDir = join(packageDir, ".migrations-scratch");
const scratchOut = join(scratchDir, "out");
const scratchConfig = join(scratchDir, "drizzle.config.ts");

/** drizzle-kit's CLI isn't in its package exports, so find it next to the package entry. */
function drizzleKitBin(): string {
  const entry = createRequire(import.meta.url).resolve("drizzle-kit");
  return join(dirname(entry), "bin.cjs");
}

export interface ScratchRun {
  /** The scratch copy of migrations/ after drizzle-kit ran. */
  out: string;
  status: number | null;
  signal: string | null;
  error?: Error;
  /** What drizzle-kit printed, when it wasn't passed through. */
  output: string;
}

/**
 * Copies migrations/ to a scratch folder, runs `drizzle-kit generate` there with `args`, calls
 * `use` with the result, and removes the scratch folder whatever happens.
 */
export function withDrizzleGenerate<T>(
  options: { args?: readonly string[]; stdio: StdioOptions; timeoutMs?: number },
  use: (run: ScratchRun) => T,
): T {
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
      [
        drizzleKitBin(),
        "generate",
        "--config",
        relative(packageDir, scratchConfig),
        ...(options.args ?? []),
      ],
      {
        cwd: packageDir,
        stdio: options.stdio,
        encoding: "utf8",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      },
    );
    return use({
      out: scratchOut,
      status: result.status,
      signal: result.signal,
      ...(result.error === undefined ? {} : { error: result.error }),
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
