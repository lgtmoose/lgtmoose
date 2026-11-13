import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fixture repos hold their own tests (a clean fixture adds one); they're data, not this
    // package's tests.
    exclude: [...configDefaults.exclude, "fixtures/**"],
  },
});
