import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  GetFoundationModelCommand,
  GetInferenceProfileCommand,
} from "@aws-sdk/client-bedrock";
import { bedrockClientOptions, bedrockModelApi, fetchStatus } from "@lgtmoose/config";
import { configPath, nodeFiles } from "../paths.js";
import { createAwsSecretStore } from "../setup/aws-secret-store.js";
import { createInquirerPrompter } from "../setup/prompter.js";
import { createStackLookup } from "./aws-cloudformation.js";
import { createDatabaseControl } from "./aws-rds.js";
import { currentAccount } from "./aws-sts.js";
import { createCdk } from "./cdk.js";
import type { DeployDeps } from "./deploy.js";
import { createGitHubAppApi } from "./github-app.js";
import {
  latestRelease,
  localVersion,
  NO_RELEASE_CHECK_ENV,
  releaseNotice,
} from "./release-check.js";

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
    models: (region) => ({
      bedrock: bedrockModelApi({
        client: new BedrockClient(bedrockClientOptions(region)),
        GetInferenceProfileCommand,
        GetFoundationModelCommand,
        GetFoundationModelAvailabilityCommand,
      }),
      get: fetchStatus,
    }),
    ...(process.env[NO_RELEASE_CHECK_ENV] === "1"
      ? {}
      : {
          releaseCheck: () =>
            releaseNotice({ local: localVersion(), latest: () => latestRelease() }),
        }),
  };
}
