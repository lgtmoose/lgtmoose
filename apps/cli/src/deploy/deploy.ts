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
import { appJwt, appSettingsUrl, type GitHubAppApi } from "./github-app.js";

/** Everything deploy and destroy touch outside their own process. */
export interface DeployDeps {
  configPath: string;
  files: Pick<SetupFiles, "exists" | "loadConfig">;
  secrets: (region: string) => SetupSecretStore;
  stacks: (region: string) => StackLookup;
  database: (region: string) => DatabaseControl;
  /** The AWS account the current credentials use. */
  account: (region: string) => Promise<string>;
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
Run it again after \`git pull\` to upgrade. It builds ARM64 container images, so Docker must be
running (on x86 Linux, with QEMU emulation for arm64).

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
  await cdk.bootstrap(await deps.account(config.region));
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
  if (app.webhookCreatedActive !== true) {
    // Setup before this version created the webhook inactive, and GitHub's API can't turn it on.
    deps.out(
      `This App was made by an earlier setup, with its webhook switched off. Tick "Active" ` +
        `under Webhook in ${appSettingsUrl(info)}, or GitHub won't send anything.\n`,
    );
  }

  // destroy turns protection off outside CloudFormation, so an interrupted destroy would leave
  // it off with a template that still says on. CloudFormation won't notice; put it back here.
  // Everything is live by now, so a failure here is a warning, not a failed deploy.
  const databaseId = outputs[STACK_NAMES.data]?.[STACK_OUTPUTS.data.databaseIdentifier];
  if (databaseId !== undefined) {
    try {
      await deps.database(config.region).setDeletionProtection(databaseId, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.out(
        `Warning: couldn't check deletion protection on ${databaseId} (${message}). ` +
          "Turn it on in the RDS console if an earlier destroy was interrupted.\n",
      );
    }
  }

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
  // DELETE_FAILED. Turn protection off straight through RDS: it works whatever state the stack
  // is in (DELETE_FAILED after an earlier attempt, say) and applies nothing from this checkout.
  const data = await deps.stacks(config.region).describe(STACK_NAMES.data);
  const outputs = data?.outputs ?? {};
  const databaseId = outputs[STACK_OUTPUTS.data.databaseIdentifier];
  const database = deps.database(config.region);
  let databaseFound = false;
  let protectionTouched = false;
  let purgeDeployed = false;
  let purgeNote = "";
  try {
    if (data !== undefined && databaseId !== undefined) {
      deps.out("Turning off the database's deletion protection…\n");
      // Set first: a failure partway through (after the modify) must still be undone.
      protectionTouched = true;
      databaseFound = (await database.setDeletionProtection(databaseId, false)) === "done";
    }
    if (flags.purge && data !== undefined) {
      if (isUpdatable(data.status)) {
        // Changing what deletion keeps needs a stack update.
        deps.out("Switching the Data stack to delete its data…\n");
        await cdk.deploy({
          stacks: [STACK_NAMES.data],
          exclusively: true,
          askToApprove: false,
          context,
        });
        purgeDeployed = true;
      } else {
        purgeNote = `\n${STACK_NAMES.data} is ${data.status}, so it couldn't be switched to delete its data. Anything listed as kept must be deleted by hand.\n`;
      }
    }
    await cdk.destroyAll(context);
  } catch (error) {
    // Leave what's still there as it was: a stack that keeps its data, a protected database.
    const message = error instanceof Error ? error.message : String(error);
    const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const notes: string[] = [];
    if (purgeDeployed) {
      notes.push(
        await cdk
          .deploy({ stacks: [STACK_NAMES.data], exclusively: true, askToApprove: false })
          .then(
            () => "Switched the Data stack back to keeping its data.",
            (restoreError: unknown) =>
              `The Data stack is still set to delete its data, with no snapshot (${describe(restoreError)}). Run pnpm lgtmoose deploy before anything deletes it.`,
          ),
      );
    }
    if (protectionTouched && databaseId !== undefined) {
      notes.push(
        await database.setDeletionProtection(databaseId, true).then(
          (result) =>
            result === "done"
              ? "Turned the database's deletion protection back on."
              : `Database ${databaseId} is already gone or being deleted.`,
          (restoreError: unknown) =>
            `Deletion protection is still off on ${databaseId} (${describe(restoreError)}); run pnpm lgtmoose deploy or turn it on in the RDS console.`,
        ),
      );
    }
    if (notes.length === 0) throw error;
    throw new Error(`${message} ${notes.join(" ")}`, { cause: error });
  }

  // Point the webhook back at the placeholder so GitHub stops calling a gateway that's gone.
  // Best effort: the stacks are already deleted, so a failure here shouldn't fail destroy.
  let webhookNote = "The App's webhook now points at a placeholder until the next deploy.";
  try {
    const app = await readAppCredentials(deps.secrets(config.region));
    await deps.github.setWebhook(jwtFor(app, deps), { url: PLACEHOLDER_WEBHOOK_URL });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    webhookNote = `Couldn't reset the App's webhook URL (${message}). GitHub will keep trying the old one until the next deploy.`;
  }

  const lines = ["", `Deleted the LGTMoose stacks in ${config.region}.`];
  if (!flags.purge || purgeNote) {
    const kept: string[] = [];
    if (databaseFound && databaseId !== undefined) {
      kept.push(`  final snapshot of database ${databaseId} (in the RDS console under Snapshots)`);
    }
    const secretArn = outputs[STACK_OUTPUTS.data.databaseSecretArn];
    const bucket = outputs[STACK_OUTPUTS.data.artifactBucketName];
    if (secretArn) kept.push(`  database credentials: ${secretArn}`);
    if (bucket) kept.push(`  artifact bucket: ${bucket}`);
    if (kept.length > 0) lines.push("Kept:", ...kept);
  }
  lines.push(
    `The GitHub App, ${SECRET_NAMES.githubApp} and ${SECRET_NAMES.githubWebhook} are kept. ${webhookNote}`,
    "pnpm lgtmoose deploy starts again with a new, empty database.",
  );
  return `${lines.join("\n")}\n${purgeNote}`;
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
