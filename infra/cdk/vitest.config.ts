import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `cdk synth` stages the repository under cdk.out for the image builds; its copies of other
    // packages' tests aren't this package's.
    exclude: [...configDefaults.exclude, "cdk.out/**"],
  },
});
