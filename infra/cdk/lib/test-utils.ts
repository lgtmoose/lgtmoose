import { App } from "aws-cdk-lib";

/** An App that skips asset bundling, so template tests don't run esbuild for every synth. */
export function appWithoutBundling(): App {
  return new App({ context: { "aws:cdk:bundling-stacks": [] } });
}
