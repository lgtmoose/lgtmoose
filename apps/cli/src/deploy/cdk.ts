import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT } from "../paths.js";

/** Outputs by stack name, as `cdk deploy --outputs-file` writes them. */
export type StackOutputs = Record<string, Record<string, string> | undefined>;

export interface DeployOptions {
  /** Stack names, or "all". */
  stacks: readonly string[] | "all";
  /** Skip the stacks these depend on (`cdk deploy --exclusively`). */
  exclusively?: boolean;
  /** Ask before IAM or security group changes that widen access. */
  askToApprove: boolean;
  context?: Readonly<Record<string, string>>;
}

/** The CDK commands deploy and destroy run. Tests fake it; the real one runs the CDK CLI. */
export interface Cdk {
  bootstrap(): Promise<void>;
  deploy(options: DeployOptions): Promise<StackOutputs>;
  destroyAll(context?: Readonly<Record<string, string>>): Promise<void>;
}

function contextArgs(context: Readonly<Record<string, string>> = {}): string[] {
  return Object.entries(context).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

export function deployArgs(options: DeployOptions, outputsFile: string): string[] {
  return [
    "deploy",
    ...(options.stacks === "all" ? ["--all"] : options.stacks),
    ...(options.exclusively ? ["--exclusively"] : []),
    "--require-approval",
    options.askToApprove ? "broadening" : "never",
    "--outputs-file",
    outputsFile,
    ...contextArgs(options.context),
  ];
}

export function destroyArgs(context?: Readonly<Record<string, string>>): string[] {
  // --force skips the CDK's own y/N prompt: destroy has already asked.
  return ["destroy", "--all", "--force", ...contextArgs(context)];
}

type Spawn = typeof nodeSpawn;

export interface CdkRunnerOptions {
  /** Absolute path of lgtmoose.config.ts; the CDK app loads it through LGTMOOSE_CONFIG. */
  configPath: string;
  region: string;
  cdkDir?: string;
  spawn?: Spawn;
}

/** Runs the CDK CLI from infra/cdk with this terminal, so its progress and prompts show. */
export function createCdk(options: CdkRunnerOptions): Cdk {
  const cdkDir = options.cdkDir ?? join(REPO_ROOT, "infra/cdk");
  const spawn = options.spawn ?? nodeSpawn;
  const cdkBin = join(cdkDir, "node_modules/aws-cdk/bin/cdk");

  function run(args: string[]): Promise<void> {
    if (!existsSync(cdkBin)) {
      return Promise.reject(
        new Error(`The CDK CLI isn't installed at ${cdkBin}. Run pnpm install.`),
      );
    }
    // cdk.json runs the app with tsx, so the workspace's bins must be on PATH.
    const bins = [join(cdkDir, "node_modules/.bin"), join(REPO_ROOT, "node_modules/.bin")];
    const env = {
      ...process.env,
      LGTMOOSE_CONFIG: options.configPath,
      AWS_REGION: options.region,
      AWS_DEFAULT_REGION: options.region,
      PATH: [...bins, process.env.PATH ?? ""].join(delimiter),
    };
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cdkBin, ...args], {
        cwd: cdkDir,
        env,
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`cdk ${args[0] ?? ""} failed (${signal ?? `exit code ${code}`}).`));
      });
    });
  }

  return {
    bootstrap: () => run(["bootstrap"]),
    async deploy(deployOptions) {
      const dir = await mkdtemp(join(tmpdir(), "lgtmoose-"));
      const outputsFile = join(dir, "outputs.json");
      try {
        await run(deployArgs(deployOptions, outputsFile));
        return JSON.parse(await readFile(outputsFile, "utf8")) as StackOutputs;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    destroyAll: (context) => run(destroyArgs(context)),
  };
}
