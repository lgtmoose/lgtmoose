import { App, Tags } from "aws-cdk-lib";
import { MetaStack } from "./meta-stack.js";

export const LGTMOOSE_VERSION = "0.0.0";

/**
 * Builds the LGTMoose CDK app. More stacks are added by their tickets:
 * Network (NIC-799), Data (NIC-800), Api (NIC-801), Workflow (NIC-810), Dashboard (NIC-840).
 * Configuration will come from lgtmoose.config.ts once NIC-798 lands.
 */
export function buildApp(app: App = new App()): App {
  Tags.of(app).add("project", "lgtmoose");
  new MetaStack(app, "Lgtmoose-Meta", { version: LGTMOOSE_VERSION });
  return app;
}
