import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  OutputFormat,
  type BundlingOptions,
  type NodejsFunctionProps,
} from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Modules the Node.js Lambda runtime already provides. */
const RUNTIME_MODULES = ["@aws-sdk/*"];

export interface LgtmooseFunctionProps extends Omit<NodejsFunctionProps, "bundling"> {
  entry: string;
  /** Merged over the shared bundling defaults; `externalModules` are added to the defaults. */
  bundling?: BundlingOptions;
}

/**
 * Every LGTMoose Lambda: Node 24 on arm64, bundled by esbuild as ESM from the workspace root.
 * Stacks pass only what differs (entry, environment, VPC, timeouts, extra bundling hooks).
 */
export function lgtmooseFunction(
  scope: Construct,
  id: string,
  props: LgtmooseFunctionProps,
): NodejsFunction {
  const { bundling = {}, ...rest } = props;
  return new NodejsFunction(scope, id, {
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    handler: "handler",
    // CDK bundles by running `pnpm exec esbuild` in projectRoot, so esbuild is a devDependency of
    // the workspace root, not of the CDK package.
    depsLockFilePath: join(REPO_ROOT, "pnpm-lock.yaml"),
    projectRoot: REPO_ROOT,
    ...rest,
    bundling: {
      format: OutputFormat.ESM,
      mainFields: ["module", "main"],
      // Dependencies such as Express and pg are CommonJS and require Node built-ins; give the
      // ESM bundle a real `require`.
      banner:
        "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      ...bundling,
      externalModules: [...RUNTIME_MODULES, ...(bundling.externalModules ?? [])],
    },
  });
}
