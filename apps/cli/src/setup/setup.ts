import { randomBytes } from "node:crypto";
import { SECRET_NAMES } from "@lgtmoose/config";
import { loadDeployConfig } from "../paths.js";
import { newState, startCallbackServer, DEFAULT_TIMEOUT_MS } from "./callback-server.js";
import { renderConfigFile } from "./config-file.js";
import type { CreatedApp, GitHubApi } from "./github.js";
import { buildManifest, installUrl, newAppUrl } from "./manifest.js";
import {
  SETUP_HELP,
  UsageError,
  parseSetupFlags,
  resolveSetupInputs,
  type SetupInputs,
} from "./options.js";
import { isPromptCancel, type Prompter } from "./prompter.js";
import {
  readExistingApp,
  storeAppSecrets,
  checkWebhookSecret,
  type ExistingApp,
  type SetupSecretStore,
} from "./secret-store.js";
import { errorMessage } from "../errors.js";

/** The filesystem calls setup makes. */
export interface SetupFiles {
  exists(path: string): Promise<boolean>;
  write(path: string, content: string): Promise<void>;
  /** Imports a config file and returns its default export. */
  loadConfig(path: string): Promise<unknown>;
}

/** Everything setup touches outside its own process, so tests need no network or AWS. */
export interface SetupDeps {
  prompter: Prompter;
  github: GitHubApi;
  secrets: (region: string) => SetupSecretStore;
  openBrowser: (url: string) => Promise<boolean>;
  files: SetupFiles;
  /** Absolute path of lgtmoose.config.ts. */
  configPath: string;
  /** Progress for the person running setup. Never receives a secret. */
  out: (text: string) => void;
  timeoutMs?: number;
}

/** Progress goes through `deps.out` as it happens; this is only what's left to print at the end. */
export interface SetupResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function describeApp(app: ExistingApp): string {
  if (app.slug === undefined)
    return "an App setup can't identify (the secret isn't the JSON it expects)";
  return app.appId === undefined ? `"${app.slug}"` : `"${app.slug}" (App ID ${app.appId})`;
}

/** Runs the manifest flow: local page → GitHub → redirect back with a one-time code. */
async function createApp(inputs: SetupInputs, deps: SetupDeps): Promise<CreatedApp> {
  const state = newState();
  const server = await startCallbackServer({
    manifestFor: (redirectUrl) =>
      buildManifest({ name: inputs.appName, owner: inputs.owner, redirectUrl }),
    formAction: newAppUrl(inputs.owner, state),
    state,
    exchange: (code) => deps.github.convertManifest(code),
    timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  try {
    deps.out(`\nOpening your browser to create the GitHub App "${inputs.appName}".\n`);
    const opened = await deps.openBrowser(server.url);
    deps.out(
      opened
        ? `If nothing opened, visit ${server.url}\n`
        : `Couldn't open a browser. Visit ${server.url} on this machine.\n`,
    );
    deps.out("Waiting for GitHub (up to 10 minutes)…\n");
    return await server.result;
  } finally {
    await server.close();
  }
}

async function chooseApp(
  existing: ExistingApp | undefined,
  webhook: string | undefined,
  inputs: SetupInputs,
  deps: SetupDeps,
  yes: boolean,
): Promise<"keep" | "create"> {
  if (existing === undefined) return "create";
  deps.out(
    `${SECRET_NAMES.githubApp} in ${inputs.region} already holds GitHub App ${describeApp(existing)}.\n`,
  );
  const problem =
    existing.slug === undefined ? undefined : checkWebhookSecret(webhook, existing).problem;
  if (problem !== undefined) {
    // Keeping it would deploy a gateway that rejects every delivery, so only offer a new App.
    deps.out(`${problem}\n`);
    const fix = "Run setup again without --yes and create a new App to fix it.";
    if (yes) throw new Error(`Can't keep the existing App: ${problem} ${fix}`);
    const replace = await deps.prompter.confirm({
      message: "Create a new App and replace both secrets?",
      default: true,
    });
    if (!replace) throw new Error(`Left both secrets as they are. ${problem}`);
    return "create";
  }
  if (existing.slug === undefined) {
    // Nothing usable to keep, but it may be someone's hand-made secret: never replace it silently.
    const left = `Left ${SECRET_NAMES.githubApp} untouched. Fix or delete it, then run setup again.`;
    if (yes) throw new Error(left);
    const replace = await deps.prompter.confirm({
      message: "Replace it with a new GitHub App?",
      default: false,
    });
    if (!replace) throw new Error(left);
    return "create";
  }
  if (yes) return "keep";
  return deps.prompter.select<"keep" | "create">({
    message: "Keep it, or create a new App?",
    choices: [
      { name: "Keep it", value: "keep" },
      { name: "Create a new App and replace both secrets", value: "create" },
    ],
    default: "keep",
  });
}

async function setUpApp(
  inputs: SetupInputs,
  deps: SetupDeps,
  yes: boolean,
): Promise<{ slug: string | undefined }> {
  const store = deps.secrets(inputs.region);
  const existing = await readExistingApp(store);
  // Read once, before anything is created. The new App's private key exists only until
  // storeAppSecrets writes it, so both secrets must be writable first: readExistingApp read
  // the App secret, and this read throws SecretScheduledForDeletion for a webhook secret that
  // can't be created again yet.
  const webhook = await store.read(SECRET_NAMES.githubWebhook);
  const choice = await chooseApp(existing, webhook, inputs, deps, yes);

  if (choice === "keep") {
    deps.out("Keeping the existing App.\n");
    return { slug: existing?.slug };
  }

  const app = await createApp(inputs, deps);
  // GitHub may not generate a webhook secret while the webhook is inactive. Make one here;
  // `lgtmoose deploy` sends it to GitHub when it sets the real webhook URL.
  const generated = app.webhookSecret === null;
  const webhookSecret = app.webhookSecret ?? randomBytes(32).toString("hex");
  const stored = await storeAppSecrets(
    store,
    {
      appId: app.id,
      slug: app.slug,
      privateKey: app.pem,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      webhookCreatedActive: true,
    },
    webhookSecret,
    { previousWebhook: webhook },
  );
  deps.out(`\nCreated GitHub App "${app.slug}" (App ID ${app.id}).\n`);
  deps.out(
    `Stored its credentials in AWS Secrets Manager (${inputs.region}):\n` +
      `  ${SECRET_NAMES.githubApp} (${stored.app})\n` +
      `  ${SECRET_NAMES.githubWebhook} (${stored.webhook}${generated ? ", generated by setup" : ""})\n`,
  );
  if (existing?.slug !== undefined && existing.slug !== app.slug) {
    deps.out(
      `The old App "${existing.slug}" still exists on GitHub. Delete it in its GitHub settings ` +
        "once the new one works.\n",
    );
  }
  return { slug: app.slug };
}

/** What setup found in an existing lgtmoose.config.ts. */
type ExistingConfig =
  | { kind: "none" }
  | { kind: "parsed"; region: string; allowedOrgs: readonly string[] }
  | { kind: "unreadable"; reason: string };

async function readExistingConfig(deps: SetupDeps): Promise<ExistingConfig> {
  try {
    const config = await loadDeployConfig(deps.files, deps.configPath);
    if (config === undefined) return { kind: "none" };
    return { kind: "parsed", region: config.region, allowedOrgs: config.allowedOrgs };
  } catch (error) {
    return { kind: "unreadable", reason: errorMessage(error) };
  }
}

/** How the existing config disagrees with this run, or an empty list when it doesn't. */
function configMismatches(existing: ExistingConfig, inputs: SetupInputs): string[] {
  if (existing.kind === "none") return [];
  if (existing.kind === "unreadable") return [`it couldn't be loaded (${existing.reason})`];
  const problems: string[] = [];
  if (existing.region !== inputs.region) {
    problems.push(`it deploys to ${existing.region}, but this run uses ${inputs.region}`);
  }
  const owner = inputs.owner.login.toLowerCase();
  if (!existing.allowedOrgs.some((org) => org.toLowerCase() === owner)) {
    problems.push(`its allowedOrgs doesn't include ${inputs.owner.login}`);
  }
  return problems;
}

/**
 * Runs before any secret is touched. A config that points somewhere else would leave the
 * secrets and the deployment in different places, so it is never kept silently: --yes stops,
 * otherwise the person decides. Returns whether the config should be replaced.
 */
async function checkExistingConfig(
  existing: ExistingConfig,
  inputs: SetupInputs,
  deps: SetupDeps,
  yes: boolean,
): Promise<"write" | "keep-or-ask" | "replace"> {
  if (existing.kind === "none") return "write";
  const problems = configMismatches(existing, inputs);
  if (problems.length === 0) return "keep-or-ask";
  const summary = `${deps.configPath} doesn't match this run: ${problems.join("; ")}.`;
  const fix = "Re-run with the region and owner the config uses, or edit or move the config first.";
  if (yes) throw new Error(`${summary} ${fix}`);
  deps.out(`${summary}\n`);
  const replace = await deps.prompter.confirm({
    message: "Continue and replace it with a config for this run?",
    default: false,
  });
  if (!replace) throw new Error(`${summary} ${fix}`);
  return "replace";
}

async function writeConfig(
  inputs: SetupInputs,
  deps: SetupDeps,
  yes: boolean,
  plan: "write" | "keep-or-ask" | "replace",
): Promise<void> {
  if (plan === "keep-or-ask") {
    const overwrite =
      !yes &&
      (await deps.prompter.confirm({
        message: `${deps.configPath} already exists. Replace it?`,
        default: false,
      }));
    if (!overwrite) {
      deps.out(`Kept the existing ${deps.configPath}.\n`);
      return;
    }
  }
  await deps.files.write(
    deps.configPath,
    renderConfigFile({ region: inputs.region, profile: inputs.profile, owner: inputs.owner.login }),
  );
  deps.out(`Wrote ${deps.configPath}.\n`);
}

function nextSteps(slug: string | undefined): string {
  const install =
    slug === undefined
      ? "Install the App on the repositories it should review, from its GitHub settings page."
      : `Install the App on the repositories it should review:\n     ${installUrl(slug)}`;
  return `
Next steps:
  1. Connect a model provider. Bedrock works with no key; for others run
     pnpm lgtmoose auth <claude|codex|cursor|api-key>   (coming in NIC-824)
  2. Deploy, which also points the App's webhook at your gateway. Until then the webhook
     aims at a placeholder and GitHub's deliveries are lost, so install after deploying:
     pnpm lgtmoose deploy
  3. ${install}
`;
}

/**
 * `lgtmoose setup`. Safe to re-run: an existing App or config is kept unless the person
 * says otherwise. Flags are checked before any dependency is built, so typos fail fast.
 */
export async function runSetup(
  argv: readonly string[],
  getDeps: () => Promise<SetupDeps>,
): Promise<SetupResult> {
  let flags;
  try {
    flags = parseSetupFlags(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      return { exitCode: 1, stdout: "", stderr: `${error.message}\n\n${SETUP_HELP}` };
    }
    throw error;
  }
  if (flags.help) return { exitCode: 0, stdout: SETUP_HELP, stderr: "" };

  const deps = await getDeps();
  try {
    const existingConfig = await readExistingConfig(deps);
    const inputs = await resolveSetupInputs(flags, deps.prompter, {
      region: existingConfig.kind === "parsed" ? existingConfig.region : undefined,
    });
    const configPlan = await checkExistingConfig(existingConfig, inputs, deps, flags.yes);
    const { slug } = await setUpApp(inputs, deps, flags.yes);
    await writeConfig(inputs, deps, flags.yes, configPlan);
    return { exitCode: 0, stdout: nextSteps(slug), stderr: "" };
  } catch (error) {
    if (isPromptCancel(error)) return { exitCode: 130, stdout: "", stderr: "Setup cancelled.\n" };
    const message = errorMessage(error);
    return { exitCode: 1, stdout: "", stderr: `Setup failed: ${message}\n` };
  }
}
