import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SetupFiles } from "./setup/setup.js";

// apps/cli/{src,dist}/ → repo root, the same place infra/cdk/lib/load-config.ts looks.
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
