import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

/**
 * One temporary directory for the whole test run, removed when the run ends (NIC-1122).
 *
 * Vitest runs this in its main process before it starts any worker. It points TMPDIR (TEMP and TMP
 * on Windows) at a fresh directory, and the workers inherit that, forked or threaded. So these go
 * in it:
 *
 * - the `cdk.out*` directory the CDK creates under `os.tmpdir()` for each `new App()` without an
 *   `outdir`, which it never removes;
 * - the tests' own `mkdtempSync(join(tmpdir(), …))` directories.
 *
 * Before this, each run of this package's tests left about 50 directories and 1.2 GB in /tmp.
 *
 * The directory is removed in three ways, all in the main process:
 *
 * - **The teardown,** when the run ends. This covers a test file that failed to collect, a
 *   worker that was killed, and a test that never removed what it made.
 * - **An `exit` listener,** when Vitest exits early without running the teardown, as it does on
 *   SIGINT or SIGTERM (Ctrl+C, a cancelled CI job). It calls `process.exit()`, which fires `exit`.
 *   Vitest's own SIGTERM handler ends the process without an `exit` event, and a signal that
 *   arrives before Vitest has a handler would too. So SIGINT, SIGTERM and SIGHUP listeners, first
 *   in line, remove the directory, then re-raise the signal if nothing else handles it. Workers can
 *   still be writing at that moment, after Ctrl+C in particular, so the directory can survive,
 *   usually empty or nearly so, until the stale sweep below.
 * - **The next run's setup,** for a run whose main process was killed outright (SIGKILL, a crash).
 *   It removes `lgtmoose-cdk-test-*` directories more than six hours old from the original temp
 *   directory.
 *
 * In watch mode the directory is emptied before each rerun, so it doesn't grow with every save.
 * Nothing is removed while tests are running: a test or a file-level hook can count on its
 * temporary files existing until the run (or the rerun) ends, and shouldn't count on them being
 * gone before then.
 */
const ENV_NAMES = ["TMPDIR", "TEMP", "TMP"] as const;
const PREFIX = "lgtmoose-cdk-test-";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** Older than any run of this package's tests, so a live run's directory is never swept. */
const STALE_MS = 6 * 3600 * 1000;

function warn(message: string, error: unknown): void {
  process.emitWarning(
    `infra/cdk global-setup: ${message}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    warn(`couldn't remove ${path}`, error);
  }
}

/** Removes the directories that runs killed outright left in `parent`. */
function sweepStale(parent: string, now: number): void {
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
      if (now - statSync(path).mtimeMs > STALE_MS) remove(path);
    } catch {
      // Gone already, or not ours to read: leave it.
    }
  }
}

/** Empties `dir`, keeping the directory itself, which the workers' TMPDIR still points at. */
function empty(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    warn(`couldn't read ${dir}`, error);
    return;
  }
  for (const name of names) remove(join(dir, name));
}

export default function setup(project: TestProject): () => void {
  const parent = tmpdir();
  sweepStale(parent, Date.now());

  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const root = mkdtempSync(join(parent, PREFIX));
  for (const name of ENV_NAMES) process.env[name] = root;

  const onExit = () => remove(root);
  process.once("exit", onExit);
  // Vitest's SIGTERM handler, and any signal before Vitest has a handler, ends the process with no
  // `exit` event. Remove the directory, then let the signal do what it would have done.
  const onSignal = (signal: NodeJS.Signals) => {
    remove(root);
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  // First in line, ahead of Vitest's own handler.
  for (const signal of SIGNALS) process.prependOnceListener(signal, onSignal);
  project.onTestsRerun(() => empty(root));

  return () => {
    process.off("exit", onExit);
    for (const signal of SIGNALS) process.off(signal, onSignal);
    for (const name of ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    remove(root);
  };
}
