import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The fixture runs clone and plan real repositories, which takes seconds, and longer on a busy
    // CI runner, so the 5 s default fails tests that are only slow, not broken.
    testTimeout: 30_000,
    // Fixture repos hold their own tests (a clean fixture adds one); they're data, not this
    // package's tests.
    exclude: [...configDefaults.exclude, "fixtures/**"],
  },
});
