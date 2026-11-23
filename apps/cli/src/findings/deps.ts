import { createStackLookup } from "../deploy/aws-cloudformation.js";
import { configPath, loadDeployConfig, nodeFiles } from "../paths.js";
import { resolveGitHubToken } from "../review/token.js";
import type { FindingsDeps } from "./findings.js";

/** The real thing: the deploy config, CloudFormation, the environment, GitHub's token and fetch. */
export function defaultFindingsDeps(): FindingsDeps {
  return {
    loadConfig: () => loadDeployConfig(nodeFiles, configPath()),
    stacks: createStackLookup,
    env: process.env,
    githubToken: () => resolveGitHubToken(process.env),
    fetch: (url, init) => fetch(url, init),
  };
}
