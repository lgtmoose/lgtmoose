import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLI_COMMAND, parseDeployConfig, type DeployConfig } from "@lgtmoose/config";
import type { SetupFiles } from "./setup/setup.js";
import { errorMessage } from "./errors.js";

// apps/cli/{src,dist}/ → repo root, the same place infra/cdk/lib/load-config.ts looks.
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * How messages tell the person to run the CLI. It only runs from a checkout of this repo
 * (config and CDK paths resolve from REPO_ROOT), where the root package script is how it's
 * started, so this matches the README and every other message.
 */
export const CLI = CLI_COMMAND;

/** Honours LGTMOOSE_CONFIG the same way `cdk synth` does, so both agree on the file. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(REPO_ROOT, env.LGTMOOSE_CONFIG ?? "lgtmoose.config.ts");
}

/** The disk, for commands that read or write lgtmoose.config.ts. */
export const nodeFiles: SetupFiles = {
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
  write: (path, content) => writeFile(path, content, "utf8"),
  // Node 24 strips the types from a .ts file on import, the same way `cdk synth` loads it.
  loadConfig: async (path) =>
    ((await import(pathToFileURL(path).href)) as { default?: unknown }).default,
};

/**
 * Loads and validates lgtmoose.config.ts, or undefined when there is none. Throws when it can't
 * be imported or fails validation; each command decides what that means for it.
 */
export async function loadDeployConfig(
  files: Pick<SetupFiles, "exists" | "loadConfig">,
  path: string,
): Promise<DeployConfig | undefined> {
  if (!(await files.exists(path))) return undefined;
  let module: unknown;
  try {
    module = await files.loadConfig(path);
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(`Couldn't load ${path}: ${message}`, { cause: error });
  }
  return parseDeployConfig(module, path);
}
