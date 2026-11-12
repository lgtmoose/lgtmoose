import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDeployConfig, type DeployConfig, type DeployConfigInput } from "@lgtmoose/config";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Used when no lgtmoose.config.ts exists, so CI and new forks can `cdk synth` before running
 * `lgtmoose setup`. It deploys nothing useful: setup writes the real config.
 */
export const EXAMPLE_CONFIG: DeployConfigInput = {
  allowedOrgs: ["example-org"],
  providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
};

export interface LoadedConfig {
  config: DeployConfig;
  /** Absolute path of the config file, or undefined when the example config was used. */
  path: string | undefined;
}

/** Loads lgtmoose.config.ts from LGTMOOSE_CONFIG or the repo root, then validates it. */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const path = resolve(REPO_ROOT, env.LGTMOOSE_CONFIG ?? "lgtmoose.config.ts");
  if (!existsSync(path)) {
    if (env.LGTMOOSE_CONFIG)
      throw new Error(`LGTMOOSE_CONFIG points at ${path}, which doesn't exist`);
    return { config: parseDeployConfig(EXAMPLE_CONFIG, "example config"), path: undefined };
  }
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  return { config: parseDeployConfig(module.default, path), path };
}
