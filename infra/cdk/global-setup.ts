import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 *   what it made;
 * - **an `exit` listener,** when Vitest exits without running the teardown. On SIGINT and SIGTERM
 *   (Ctrl+C, a cancelled CI job), Vitest's own handler calls `process.exit()`, which fires `exit`;
 * - **the next run's setup,** for a run whose main process was killed outright (SIGKILL, a crash).
 *   Each directory holds its owner's PID in `.owner`. Setup removes the `lgtmoose-cdk-test-*`
 *   directories that belong to this user and whose owner process is gone, in one attempt, and says
 *   nothing if that fails. On a platform without `process.getuid`, it sweeps nothing.
 *
 * Nothing is removed while the run is going: a test or a file-level hook can count on its
 * temporary files existing until the run ends, and shouldn't count on them being gone before then.
 * In watch mode, that means the directory grows with each rerun until the watcher exits, which is
 * fine for a dev loop.
 */
const ENV_NAMES = ["TMPDIR", "TEMP", "TMP"] as const;
const PREFIX = "lgtmoose-cdk-test-";
const OWNER_FILE = ".owner";

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best effort: a later run, or the system's own temp cleanup, gets it.
  }
}

/** Whether a process with this PID still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Removes the directories in `parent` left by this user's runs whose process is gone. */
function sweepOrphans(parent: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(parent, name);
    try {
      if (statSync(path).uid !== uid) continue;
      const pid = Number.parseInt(readFileSync(join(path, OWNER_FILE), "utf8"), 10);
      if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    } catch {
      // No owner file, or not ours to read: leave it.
      continue;
    }
    removeQuietly(path);
  }
}

export default function setup(): () => void {
  const parent = tmpdir();
  sweepOrphans(parent);

  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const root = mkdtempSync(join(parent, PREFIX));
  writeFileSync(join(root, OWNER_FILE), String(process.pid));
  for (const name of ENV_NAMES) process.env[name] = root;

  const onExit = () => removeQuietly(root);
  process.once("exit", onExit);

  return () => {
    process.off("exit", onExit);
    for (const name of ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    } catch (error) {
      process.emitWarning(
        `infra/cdk global-setup: couldn't remove ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}
