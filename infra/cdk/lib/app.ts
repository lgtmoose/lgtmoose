import { App, Tags, type Environment } from "aws-cdk-lib";
import {
  CDK_CONTEXT,
  STACK_NAMES,
  egressAllowlist,
  modelFor,
  resolveRoles,
  type DeployConfig,
  type ProviderConfig,
} from "@lgtmoose/config";
import { ApiStack } from "./api-stack.js";
import { DATABASE_NAME, DataStack } from "./data-stack.js";
import { MetaStack } from "./meta-stack.js";
import { NetworkStack } from "./network-stack.js";
import { ProxyStack } from "./proxy-stack.js";
import { ALLOW_UNVERIFIED_CURSOR_ENV } from "./sandbox-image.js";
import { WorkflowStack } from "./workflow-stack.js";

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
  proxy: ProxyStack;
  workflow: WorkflowStack;
}

/**
 * Builds the LGTMoose CDK app from a validated config. Stack still to come: Dashboard (NIC-840).
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

  const proxy = new ProxyStack(app, STACK_NAMES.proxy, {
    env,
    profile: config.profile,
    vpc: network.vpc,
    proxySecurityGroup: network.proxySecurityGroup,
    allowedHosts: egressAllowlist(config),
  });

  const reviewer = resolveRoles(config).reviewer;
  const workflow = new WorkflowStack(app, STACK_NAMES.workflow, {
    env,
    profile: config.profile,
    providers: config.providers,
    reviewerProviderId: reviewer.id,
    reviewerModel: reviewerModel(reviewer),
    maxConcurrency: config.maxConcurrency,
    shadow: config.shadow,
    vpc: network.vpc,
    controlSubnets: { subnetGroupName: "app" },
    controlSecurityGroup: network.controlSecurityGroup,
    sandboxSubnets: network.sandboxSubnets,
    sandboxSecurityGroup: network.sandboxSecurityGroup,
    proxyUrl: proxy.proxyUrl,
    artifactBucket: data.artifactBucket,
    databaseSecret: data.databaseSecret,
    databaseName: DATABASE_NAME,
    githubAppSecret: data.githubAppSecret,
    providerSecrets: data.providerSecrets,
    jobQueue: api.jobQueue,
    deadLetterQueue: api.deadLetterQueue,
    allowedOrgs: config.allowedOrgs,
    reconcileIntervalMinutes: config.reconcileIntervalMinutes,
    reconcileLookbackHours: config.reconcileLookbackHours,
    feedback: config.feedback,
    maxReplyJudgements: config.maxReplyJudgements,
    embeddings: config.learnings.embeddings,
    ...(config.tickets === undefined ? {} : { tickets: config.tickets }),
    allowUnverifiedCursor:
      process.env[ALLOW_UNVERIFIED_CURSOR_ENV] === "1" ||
      isTrue(app.node.tryGetContext(CDK_CONTEXT.allowUnverifiedCursor)),
  });
  workflow.addDependency(data);
  // Sandbox tasks can only reach model APIs once the proxy runs.
  workflow.addDependency(proxy);

  return { app, meta, network, data, api, proxy, workflow };
}

/**
 * The reviewer's model: the provider's standard tier, else the harness default (`sonnet` for
 * Claude Code and the Agent SDK) or, for other harnesses, their CLI's own default.
 */
export function reviewerModel(provider: ProviderConfig): string {
  return modelFor(provider, "standard") ?? "";
}
