import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openBrowser } from "./browser.js";
import { createGitHubApi } from "./github.js";
import { createInquirerPrompter } from "./prompter.js";
import { createAwsSecretStore } from "./aws-secret-store.js";
import type { SetupDeps } from "./setup.js";

// apps/cli/{src,dist}/setup/ → repo root, the same place infra/cdk/lib/load-config.ts looks.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Honours LGTMOOSE_CONFIG the same way `cdk synth` does, so both agree on the file. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(REPO_ROOT, env.LGTMOOSE_CONFIG ?? "lgtmoose.config.ts");
}

/** The real thing: inquirer, GitHub, AWS Secrets Manager, the browser and the disk. */
export async function defaultSetupDeps(): Promise<SetupDeps> {
  return {
    prompter: await createInquirerPrompter(),
    github: createGitHubApi(),
    secrets: createAwsSecretStore,
    openBrowser,
    files: {
      exists: (path) =>
        access(path).then(
          () => true,
          () => false,
        ),
      write: (path, content) => writeFile(path, content, "utf8"),
      // Node 24 strips the types from a .ts file on import, the same way `cdk synth` loads it.
      loadConfig: async (path) =>
        ((await import(pathToFileURL(path).href)) as { default?: unknown }).default,
    },
    configPath: configPath(),
    out: (text) => process.stdout.write(text),
  };
}
