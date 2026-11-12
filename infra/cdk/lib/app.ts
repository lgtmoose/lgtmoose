import { App, Tags, type Environment } from "aws-cdk-lib";
import type { DeployConfig } from "@lgtmoose/config";
import { ApiStack } from "./api-stack.js";
import { DataStack } from "./data-stack.js";
import { MetaStack } from "./meta-stack.js";
import { NetworkStack } from "./network-stack.js";

export const LGTMOOSE_VERSION = "0.0.0";

/** CDK context flag (`-c lgtmoose:allowDatabaseDeletion=true`) that `lgtmoose destroy` sets. */
export const ALLOW_DATABASE_DELETION = "lgtmoose:allowDatabaseDeletion";

/** Context values from `-c` arrive as strings; from cdk.json or tests they may be booleans. */
function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

export interface LgtmooseStacks {
  app: App;
  meta: MetaStack;
  network: NetworkStack;
  data: DataStack;
  api: ApiStack;
}

/**
 * Builds the LGTMoose CDK app from a validated config. Stacks still to come:
 * Workflow (NIC-810), Dashboard (NIC-840).
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
    allowDatabaseDeletion: isTrue(app.node.tryGetContext(ALLOW_DATABASE_DELETION)),
  });

  const api = new ApiStack(app, "Lgtmoose-Api", { env, version: LGTMOOSE_VERSION });
  // Code that may read the database deploys after the Data stack, so migrations finish first.
  api.addDependency(data);

  return { app, meta, network, data, api };
}
