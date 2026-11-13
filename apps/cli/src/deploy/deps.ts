import { configPath, nodeFiles } from "../paths.js";
import { createAwsSecretStore } from "../setup/aws-secret-store.js";
import { createInquirerPrompter } from "../setup/prompter.js";
import { createStackLookup } from "./aws-cloudformation.js";
import { createDatabaseControl } from "./aws-rds.js";
import { currentAccount } from "./aws-sts.js";
import { createCdk } from "./cdk.js";
import type { DeployDeps } from "./deploy.js";
import { createGitHubAppApi } from "./github-app.js";

/** The real thing: the CDK CLI, AWS, GitHub, the disk and a terminal. */
export async function defaultDeployDeps(): Promise<DeployDeps> {
  return {
    configPath: configPath(),
    files: nodeFiles,
    secrets: createAwsSecretStore,
    stacks: createStackLookup,
    database: createDatabaseControl,
    account: currentAccount,
    cdk: createCdk,
    github: createGitHubAppApi(),
    prompter: await createInquirerPrompter(),
    out: (text) => process.stdout.write(text),
  };
}
