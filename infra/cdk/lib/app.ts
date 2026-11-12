import { App, Tags, type Environment } from "aws-cdk-lib";
import type { DeployConfig } from "@lgtmoose/config";
import { DataStack } from "./data-stack.js";
import { MetaStack } from "./meta-stack.js";
import { NetworkStack } from "./network-stack.js";

export const LGTMOOSE_VERSION = "0.0.0";

export interface LgtmooseStacks {
  app: App;
  meta: MetaStack;
  network: NetworkStack;
  data: DataStack;
}

/**
 * Builds the LGTMoose CDK app from a validated config. Stacks still to come:
 * Api (NIC-801), Workflow (NIC-810), Dashboard (NIC-840).
 */
export function buildApp(config: DeployConfig, app: App = new App()): LgtmooseStacks {
  Tags.of(app).add("project", "lgtmoose");
  const env: Environment = {
    region: config.region,
    ...(process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT } : {}),
  };

  const meta = new MetaStack(app, "Lgtmoose-Meta", { env, version: LGTMOOSE_VERSION });
  const network = new NetworkStack(app, "Lgtmoose-Network", { env, profile: config.profile });
  const data = new DataStack(app, "Lgtmoose-Data", {
    env,
    profile: config.profile,
    providers: config.providers,
    vpc: network.vpc,
    controlSecurityGroup: network.controlSecurityGroup,
  });

  return { app, meta, network, data };
}
