import { configPath, nodeFiles } from "../paths.js";
import { openBrowser } from "./browser.js";
import { createGitHubApi } from "./github.js";
import { createInquirerPrompter } from "./prompter.js";
import { createAwsSecretStore } from "./aws-secret-store.js";
import type { SetupDeps } from "./setup.js";

export { configPath } from "../paths.js";

/** The real thing: inquirer, GitHub, AWS Secrets Manager, the browser and the disk. */
export async function defaultSetupDeps(): Promise<SetupDeps> {
  return {
    prompter: await createInquirerPrompter(),
    github: createGitHubApi(),
    secrets: createAwsSecretStore,
    openBrowser,
    files: nodeFiles,
    configPath: configPath(),
    out: (text) => process.stdout.write(text),
  };
}
