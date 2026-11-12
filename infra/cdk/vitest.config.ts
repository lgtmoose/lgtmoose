import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Synthesizing CDK stacks takes several seconds on a cold CI runner.
    testTimeout: 30_000,
  },
});
