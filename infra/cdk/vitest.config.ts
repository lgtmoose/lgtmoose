import { configDefaults, defineConfig } from "vitest/config";

// `cdk synth` stages Docker image directories (the egress proxy's sources) under cdk.out; they
// belong to other packages and mustn't be collected or transformed here.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "cdk.out/**"] },
});
