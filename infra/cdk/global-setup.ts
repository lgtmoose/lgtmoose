import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One temporary directory for the whole test run (NIC-1122).
 *
 * Vitest runs this in its main process before it starts any worker. Setup makes the directory
 * with `mkdtempSync` under the original temp directory and points TMPDIR (TEMP and TMP on
 * Windows) at it. The workers inherit that, forked or threaded, so these go in it:
 *
 * - the `cdk.out*` directory the CDK creates under `os.tmpdir()` for each `new App()` without an
 *   `outdir`, which it never removes;
 * - the tests' own `mkdtempSync(join(tmpdir(), …))` directories.
 *
 * Before this, each run of this package's tests left about 50 directories and 1.2 GB in /tmp.
 *
 * The directory is removed by:
 *
 * - **the teardown,** when the run ends. It puts TMPDIR, TEMP and TMP back first. This also covers
 *   a test file that failed to collect, a worker that was killed, and a test that never removed
 *   what it made. If the removal fails, the `exit` listener below stays registered to try again;
 * - **an `exit` listener,** when Vitest exits without a successful teardown. On SIGINT and SIGTERM
 *   (Ctrl+C, a cancelled CI job), Vitest's own handler calls `process.exit()`, which fires `exit`.
 *
 * A run whose main process is killed outright (SIGKILL, a crash) runs neither, and leaves its one
 * `lgtmoose-cdk-test-*` directory behind for the system's temp cleanup or a person to remove.
 *
 * Nothing is removed while the run is going: a test or a file-level hook can count on its
 * temporary files existing until the run ends, and shouldn't count on them being gone before then.
 * In watch mode, that means the directory grows with each rerun until the watcher exits, which is
 * fine for a dev loop.
 */
const ENV_NAMES = ["TMPDIR", "TEMP", "TMP"] as const;

function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

export default function setup(): () => void {
  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const root = mkdtempSync(join(tmpdir(), "lgtmoose-cdk-test-"));
  for (const name of ENV_NAMES) process.env[name] = root;

  const onExit = () => {
    try {
      removeRoot(root);
    } catch {
      // Nothing more to do while the process exits.
    }
  };
  process.once("exit", onExit);

  return () => {
    for (const name of ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      removeRoot(root);
      process.off("exit", onExit);
    } catch (error) {
      // The exit listener stays registered, so the removal is tried again after the pool closes.
      process.emitWarning(
        `infra/cdk global-setup: couldn't remove ${root} yet, trying again on exit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
