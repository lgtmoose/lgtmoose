import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Every temporary file these tests write goes in one directory per worker process, which is removed
 * after each test file (NIC-1122). It holds:
 *
 * - the `cdk.out*` directory the CDK creates under `os.tmpdir()` for each `new App()` without an
 *   `outdir`, which it never removes;
 * - the tests' own `mkdtempSync(join(tmpdir(), …))` directories.
 *
 * Before this, each run of this package's tests left about 50 directories and 1.2 GB in /tmp.
 *
 * It works by pointing TMPDIR (TEMP and TMP on Windows) at that directory before any test file is
 * imported, so a new test can't forget to clean up. A worker that runs a second file creates the
 * same directory again, because the CDK caches the temporary directory it first sees. This needs
 * each worker to have its own environment, which holds for Vitest's default `forks` pool. A worker
 * killed mid-file still leaves its directory behind.
 */
const MARK = "LGTMOOSE_CDK_TEST_TMPDIR";

function workerTmpdir(): string {
  const dir = process.env[MARK] ?? join(tmpdir(), `lgtmoose-cdk-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  process.env[MARK] = dir;
  process.env.TMPDIR = dir;
  process.env.TEMP = dir;
  process.env.TMP = dir;
  return dir;
}

const dir = workerTmpdir();

// The stacks that build images stage a copy of the repository, so there can be hundreds of
// megabytes to remove: give it longer than the 10 s hook default.
afterAll(() => rm(dir, { recursive: true, force: true }), 120_000);
