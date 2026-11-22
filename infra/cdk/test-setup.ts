import { mkdirSync, mkdtempSync } from "node:fs";
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
 * That only works where each test file has its own `process.env`, which means a forked process.
 * vitest.config.ts pins `pool: "forks"`. Under a thread pool, the workers share one environment,
 * so pointing TMPDIR anywhere would move it for every file at once. There this setup leaves TMPDIR
 * alone and says so, and the tests leave their temporary files behind as before.
 *
 * The CDK caches the first temporary directory it sees, for the life of the process. If a process
 * ever runs a second file, that file recreates the first file's directory under the same name,
 * which this setup made itself, rather than making a new one the CDK wouldn't use.
 */
const OWN = "LGTMOOSE_CDK_TEST_TMPDIR";
const ENV_NAMES = ["TMPDIR", "TEMP", "TMP"] as const;

function fileTmpdir(): string | undefined {
  if (!isMainThread) {
    process.emitWarning(
      'infra/cdk test-setup: tests are running in worker threads, which share one environment, so their temporary files aren\'t redirected or removed. Use pool: "forks".',
    );
    return undefined;
  }
  const earlier = process.env[OWN];
  if (earlier !== undefined) {
    // A second file in this process: the CDK still uses the first file's directory. Make it
    // again; it fails if anything else made that path meanwhile.
    mkdirSync(earlier, { mode: 0o700 });
    return earlier;
  }
  const dir = mkdtempSync(join(tmpdir(), "lgtmoose-cdk-test-"));
  process.env[OWN] = dir;
  return dir;
}

const original = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const dir = fileTmpdir();

if (dir !== undefined) {
  for (const name of ENV_NAMES) process.env[name] = dir;

  // The stacks that build images stage a copy of the repository, so there can be hundreds of
  // megabytes to remove: give it longer than the 10 s hook default, retry a busy file (EBUSY,
  // EPERM on Windows), and only warn if it still fails, rather than failing a file whose tests
  // passed.
  afterAll(async () => {
    for (const name of ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      process.emitWarning(
        `infra/cdk test-setup: couldn't remove ${dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 120_000);
}
