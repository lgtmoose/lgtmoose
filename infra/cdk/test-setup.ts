import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterAll } from "vitest";

/**
 * Each test file's temporary files go in a directory of its own, removed after the file (NIC-1122).
 * It holds:
 *
 * - the `cdk.out*` directory the CDK creates under `os.tmpdir()` for each `new App()` without an
 *   `outdir`, which it never removes;
 * - the tests' own `mkdtempSync(join(tmpdir(), …))` directories.
 *
 * Before this, each run of this package's tests left about 50 directories and 1.2 GB in /tmp.
 *
 * It works by pointing TMPDIR (TEMP and TMP on Windows) at that directory before the test file is
 * imported, so a new test can't forget to clean up. The originals are put back after the file.
 *
 * That's only safe when each test file runs in a fresh process of its own, which is what
 * vitest.config.ts pins (`pool: "forks"`, `isolate: true`). The CDK also caches the first temp
 * directory it sees for the life of the process. In any other mode the setup does nothing and
 * warns once per process, and the tests leave their temp files behind as before. Those modes are
 * a thread pool (its workers share one `process.env`), `isolate: false`, or a second file in a
 * process that already ran one.
 */
const STARTED = Symbol.for("lgtmoose.cdk.testTmpdir.started");
const WARNED = Symbol.for("lgtmoose.cdk.testTmpdir.warned");
const ENV_NAMES = ["TMPDIR", "TEMP", "TMP"] as const;
/** Shorter than the hook's timeout, so a slow removal never fails a file whose tests passed. */
const REMOVE_WAIT_MS = 100_000;

type Marked = typeof globalThis & {
  [STARTED]?: true;
  [WARNED]?: true;
  /** Vitest's worker state; read defensively, since it isn't public API. */
  __vitest_worker__?: { config?: { isolate?: boolean } };
};
const marked = globalThis as Marked;

function warnOnce(reason: string): void {
  if (marked[WARNED]) return;
  marked[WARNED] = true;
  process.emitWarning(
    `infra/cdk test-setup: ${reason}, so temporary files aren't redirected or removed. Run with pool: "forks" and isolate: true.`,
  );
}

function skipReason(): string | undefined {
  if (!isMainThread) return "tests are running in worker threads, which share one environment";
  if (marked.__vitest_worker__?.config?.isolate === false) return "isolate is off";
  if (marked[STARTED]) return "this process already ran a test file";
  return undefined;
}

const reason = skipReason();
if (reason !== undefined) {
  warnOnce(reason);
} else {
  marked[STARTED] = true;
  const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  const dir = mkdtempSync(join(tmpdir(), "lgtmoose-cdk-test-"));
  for (const name of ENV_NAMES) process.env[name] = dir;

  // Also on exit: a file that fails to collect never reaches afterAll, and a removal that
  // timed out below is finished here.
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing more to do while the process exits.
    }
  });

  // The stacks that build images stage a copy of the repository, so there can be hundreds of
  // megabytes to remove. Busy files (EBUSY, EPERM on Windows) are retried, and a failure or a
  // slow disk only warns.
  afterAll(async () => {
    for (const name of ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), REMOVE_WAIT_MS);
      timer.unref();
    });
    try {
      const result = await Promise.race([
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
        timedOut,
      ]);
      if (result === "timeout") {
        process.emitWarning(
          `infra/cdk test-setup: removing ${dir} took over ${REMOVE_WAIT_MS / 1000} s; it's removed on exit.`,
        );
      }
    } catch (error) {
      process.emitWarning(
        `infra/cdk test-setup: couldn't remove ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }, REMOVE_WAIT_MS + 20_000);
}
