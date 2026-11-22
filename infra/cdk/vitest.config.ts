import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Synthesising a whole CDK app takes seconds, and longer on a busy CI runner, so the 5 s default
    // fails stack tests that are only slow, not broken.
    testTimeout: 30_000,
    // `cdk synth` stages the repository under cdk.out for the image builds; its copies of other
    // packages' tests aren't this package's.
    exclude: [...configDefaults.exclude, "cdk.out/**"],
    // Synth output and test temp files go in a per-file directory that's cleaned up (NIC-1122).
    // That needs each test file to run in a fresh process of its own: forked, isolated workers.
    pool: "forks",
    isolate: true,
    setupFiles: ["./test-setup.ts"],
  },
});
