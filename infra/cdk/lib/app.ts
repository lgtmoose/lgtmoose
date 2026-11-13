import { App, Tags, type Environment } from "aws-cdk-lib";
import { CDK_CONTEXT, STACK_NAMES, type DeployConfig } from "@lgtmoose/config";
import { ApiStack } from "./api-stack.js";
import { DataStack } from "./data-stack.js";
import { MetaStack } from "./meta-stack.js";
import { NetworkStack } from "./network-stack.js";

export const LGTMOOSE_VERSION = "0.0.0";

/** CDK context flag (`-c lgtmoose:allowDatabaseDeletion=true`) that `lgtmoose destroy` sets. */
export const ALLOW_DATABASE_DELETION = CDK_CONTEXT.allowDatabaseDeletion;
/** CDK context flag (`-c lgtmoose:purge=true`) that `lgtmoose destroy --purge` sets. */
export const PURGE_DATA = CDK_CONTEXT.purge;

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

  const meta = new MetaStack(app, STACK_NAMES.meta, { env, version: LGTMOOSE_VERSION });
  const network = new NetworkStack(app, STACK_NAMES.network, { env, profile: config.profile });
  const data = new DataStack(app, STACK_NAMES.data, {
    env,
    profile: config.profile,
    providers: config.providers,
    vpc: network.vpc,
    controlSecurityGroup: network.controlSecurityGroup,
    allowDatabaseDeletion: isTrue(app.node.tryGetContext(ALLOW_DATABASE_DELETION)),
    purge: isTrue(app.node.tryGetContext(PURGE_DATA)),
  });

  const api = new ApiStack(app, STACK_NAMES.api, {
    env,
    version: LGTMOOSE_VERSION,
    allowedOrgs: config.allowedOrgs,
  });
  // Code that may read the database deploys after the Data stack, so migrations finish first.
  api.addDependency(data);

  return { app, meta, network, data, api };
}
