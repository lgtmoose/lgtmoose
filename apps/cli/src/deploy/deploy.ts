import { parseArgs } from "node:util";
import {
  CDK_CONTEXT,
  SECRET_NAMES,
  STACK_NAMES,
  STACK_OUTPUTS,
  providerNeedsSecret,
  type DeployConfig,
} from "@lgtmoose/config";
import { loadDeployConfig } from "../paths.js";
import { PLACEHOLDER_WEBHOOK_URL, installUrl } from "../setup/manifest.js";
import { isPromptCancel, type Prompter } from "../setup/prompter.js";
import {
  readAppCredentials,
  readWebhookSecret,
  type AppCredentials,
  type SetupSecretStore,
} from "../setup/secret-store.js";
import type { SetupFiles } from "../setup/setup.js";
import { isUpdatable, type StackLookup } from "./aws-cloudformation.js";
import type { DatabaseControl } from "./aws-rds.js";
import type { Cdk } from "./cdk.js";
import { appJwt, type GitHubAppApi } from "./github-app.js";

/** Everything deploy and destroy touch outside their own process. */
export interface DeployDeps {
  configPath: string;
  files: Pick<SetupFiles, "exists" | "loadConfig">;
  secrets: (region: string) => SetupSecretStore;
  stacks: (region: string) => StackLookup;
  database: (region: string) => DatabaseControl;
  cdk: (config: { configPath: string; region: string }) => Cdk;
  github: GitHubAppApi;
  prompter: Prompter;
  /** Progress for the person. Never receives a secret. */
  out: (text: string) => void;
  now?: () => Date;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const DEPLOY_HELP = `Usage: lgtmoose deploy [--yes]

Deploys every LGTMoose stack to the account and region in lgtmoose.config.ts, bootstrapping
the CDK there the first time, then points the GitHub App's webhook at the new gateway.
Run it again after \`git pull\` to upgrade.

Options:
  --yes   Don't stop to approve IAM and security group changes
  -h, --help
`;

export const DESTROY_HELP = `Usage: lgtmoose destroy [--purge] [--yes]

Deletes the LGTMoose stacks. By default the database is kept as a final snapshot, with the
secret that unlocks it, and the artifact bucket is kept. The GitHub App and its secrets stay.

Options:
  --purge  Also delete the database without a snapshot, its secret and the bucket. Redeploys
           the Data stack from this checkout first; CloudWatch logs expire on their own
  --yes    Don't ask for confirmation
  -h, --help
`;

class UsageError extends Error {}

function parseFlags(argv: readonly string[], withPurge: boolean) {
  try {
    const { values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        ...(withPurge ? { purge: { type: "boolean" as const } } : {}),
      },
    });
    return {
      yes: values.yes === true,
      help: values.help === true,
      purge: (values as { purge?: boolean }).purge === true,
    };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function loadConfig(deps: DeployDeps): Promise<DeployConfig> {
  const config = await loadDeployConfig(deps.files, deps.configPath);
  if (config === undefined) {
    throw new Error(`No config at ${deps.configPath}. Run pnpm lgtmoose setup first.`);
  }
  return config;
}

/** Everything deploy needs from Secrets Manager, checked before CloudFormation is touched. */
async function checkSecrets(config: DeployConfig, store: SetupSecretStore) {
  const app = await readAppCredentials(store);
  const webhook = await readWebhookSecret(store, app);
  if (webhook.problem !== undefined) {
    throw new Error(`${webhook.problem} Run pnpm lgtmoose setup and create a new App to fix it.`);
  }
  const webhookSecret = webhook.secret;
  for (const provider of config.providers.filter(providerNeedsSecret)) {
    if ((await store.read(SECRET_NAMES.provider(provider.id))) === undefined) {
      throw new Error(
        `Provider "${provider.id}" needs ${SECRET_NAMES.provider(provider.id)}, which doesn't ` +
          `exist in ${config.region}. Run pnpm lgtmoose auth for it, or remove it from the config.`,
      );
    }
  }
  return { app, webhookSecret };
}

function jwtFor(app: AppCredentials, deps: DeployDeps): string {
  return appJwt(app.appId, app.privateKey, deps.now?.() ?? new Date());
}

async function deploy(flags: { yes: boolean }, deps: DeployDeps): Promise<string> {
  const config = await loadConfig(deps);
  const { app, webhookSecret } = await checkSecrets(config, deps.secrets(config.region));
  const cdk = deps.cdk({ configPath: deps.configPath, region: config.region });

  // Every time, not just the first: it's a no-op when current, and a newer aws-cdk after
  // `git pull` can need a newer bootstrap stack.
  deps.out(`Bootstrapping the CDK in ${config.region} (quick when it's already done)…\n`);
  await cdk.bootstrap();
  deps.out(`Deploying LGTMoose to ${config.region}…\n`);
  const outputs = await cdk.deploy({ stacks: "all", askToApprove: !flags.yes });
  const webhookUrl = outputs[STACK_NAMES.api]?.[STACK_OUTPUTS.api.githubWebhookUrl];
  if (webhookUrl === undefined) {
    throw new Error(
      `The deploy finished but ${STACK_NAMES.api} has no ${STACK_OUTPUTS.api.githubWebhookUrl} output.`,
    );
  }

  const jwt = jwtFor(app, deps);
  const info = await deps.github.getApp(jwt);
  if (info.id !== app.appId) {
    throw new Error(`GitHub says this key belongs to App ${info.id}, not ${app.appId}.`);
  }
  await deps.github.setWebhook(jwt, {
    url: webhookUrl,
    secret: webhookSecret,
    contentType: "json",
  });
  deps.out(`Pointed the webhook of GitHub App "${info.slug}" at ${webhookUrl}.\n`);

  return `
LGTMoose is deployed.

Install the App on the repositories it should review:
  ${installUrl(info.slug)}

To upgrade later: git pull && pnpm lgtmoose deploy
`;
}

async function destroy(flags: { yes: boolean; purge: boolean }, deps: DeployDeps): Promise<string> {
  const config = await loadConfig(deps);
  const kept = flags.purge
    ? "The database, its secret and the artifact bucket will be deleted for good. First the " +
      "Data stack is redeployed from this checkout, to change what deletion keeps. Postgres " +
      "logs in CloudWatch expire on their own retention schedule."
    : "The database is kept as a final snapshot, and the artifact bucket is kept.";
  deps.out(`This deletes the LGTMoose stacks in ${config.region}. ${kept}\n`);
  if (!flags.yes) {
    const go = await deps.prompter.confirm({
      message: flags.purge ? "Delete everything, including all review data?" : "Delete the stacks?",
      default: false,
    });
    if (!go) return "Nothing was deleted.\n";
  }

  const cdk = deps.cdk({ configPath: deps.configPath, region: config.region });
  const context: Record<string, string> = { [CDK_CONTEXT.allowDatabaseDeletion]: "true" };
  if (flags.purge) context[CDK_CONTEXT.purge] = "true";

  // RDS refuses to delete a protected database, which would leave the Data stack in
  // DELETE_FAILED. Turn protection off first.
  const data = await deps.stacks(config.region).describe(STACK_NAMES.data);
  let purgeNote = "";
  if (data !== undefined && data.status !== "DELETE_COMPLETE") {
    if (flags.purge && isUpdatable(data.status)) {
      // Changing what deletion keeps needs a stack update; this also turns protection off.
      deps.out("Switching the Data stack to delete its data…\n");
      await cdk.deploy({
        stacks: [STACK_NAMES.data],
        exclusively: true,
        askToApprove: false,
        context,
      });
    } else {
      // Straight through RDS: works whatever state the stack is in (DELETE_FAILED after an
      // earlier attempt, say) and applies nothing else from the checked-out code.
      const id = data.outputs[STACK_OUTPUTS.data.databaseIdentifier];
      if (id !== undefined) {
        deps.out("Turning off the database's deletion protection…\n");
        await deps
          .database(config.region)
          .disableDeletionProtection(config.profile === "lean" ? "instance" : "cluster", id);
      }
      if (flags.purge) {
        purgeNote = `\n${STACK_NAMES.data} is ${data.status}, so it couldn't be switched to delete its data. The final snapshot, its secret and the bucket are kept: delete them by hand.\n`;
      }
    }
  }
  await cdk.destroyAll(context);

  // Point the webhook back at the placeholder so GitHub stops calling a gateway that's gone.
  // Best effort: the stacks are already deleted, so a failure here shouldn't fail destroy.
  let webhookNote = "";
  try {
    const app = await readAppCredentials(deps.secrets(config.region));
    await deps.github.setWebhook(jwtFor(app, deps), { url: PLACEHOLDER_WEBHOOK_URL });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    webhookNote = `\nCouldn't reset the App's webhook URL (${message}). GitHub will keep trying the old one until the next deploy.\n`;
  }

  const lines = ["", `Deleted the LGTMoose stacks in ${config.region}.`];
  if ((!flags.purge || purgeNote) && data !== undefined) {
    const id = data.outputs[STACK_OUTPUTS.data.databaseIdentifier];
    const secretArn = data.outputs[STACK_OUTPUTS.data.databaseSecretArn];
    const bucket = data.outputs[STACK_OUTPUTS.data.artifactBucketName];
    lines.push("Kept:");
    if (id) lines.push(`  final snapshot of database ${id} (in the RDS console under Snapshots)`);
    if (secretArn) lines.push(`  its credentials: ${secretArn}`);
    if (bucket) lines.push(`  artifact bucket: ${bucket}`);
  }
  lines.push(
    `The GitHub App and ${SECRET_NAMES.githubApp} are untouched. pnpm lgtmoose deploy starts again with a new, empty database.`,
  );
  return `${lines.join("\n")}\n${purgeNote}${webhookNote}`;
}

async function runCommand(
  argv: readonly string[],
  getDeps: () => Promise<DeployDeps>,
  command: "deploy" | "destroy",
): Promise<CommandResult> {
  const help = command === "deploy" ? DEPLOY_HELP : DESTROY_HELP;
  let flags;
  try {
    flags = parseFlags(argv, command === "destroy");
  } catch (error) {
    if (error instanceof UsageError) {
      return { exitCode: 1, stdout: "", stderr: `${error.message}\n\n${help}` };
    }
    throw error;
  }
  if (flags.help) return { exitCode: 0, stdout: help, stderr: "" };

  const deps = await getDeps();
  try {
    const stdout = command === "deploy" ? await deploy(flags, deps) : await destroy(flags, deps);
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    if (isPromptCancel(error))
      return { exitCode: 130, stdout: "", stderr: `${command} cancelled.\n` };
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${command === "deploy" ? "Deploy" : "Destroy"} failed: ${message}\n`,
    };
  }
}

/** `lgtmoose deploy`. */
export function runDeploy(argv: readonly string[], getDeps: () => Promise<DeployDeps>) {
  return runCommand(argv, getDeps, "deploy");
}

/** `lgtmoose destroy`. */
export function runDestroy(argv: readonly string[], getDeps: () => Promise<DeployDeps>) {
  return runCommand(argv, getDeps, "destroy");
}
