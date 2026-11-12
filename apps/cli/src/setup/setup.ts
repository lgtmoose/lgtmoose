import { randomBytes } from "node:crypto";
import { SECRET_NAMES } from "@lgtmoose/config";
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
  type ExistingApp,
  type SecretStore,
} from "./secret-store.js";

/** The filesystem calls setup makes. */
export interface SetupFiles {
  exists(path: string): Promise<boolean>;
  write(path: string, content: string): Promise<void>;
}

/** Everything setup touches outside its own process, so tests need no network or AWS. */
export interface SetupDeps {
  prompter: Prompter;
  github: GitHubApi;
  secrets: (region: string) => SecretStore;
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
  inputs: SetupInputs,
  deps: SetupDeps,
  yes: boolean,
): Promise<"keep" | "create"> {
  if (existing === undefined) return "create";
  deps.out(
    `${SECRET_NAMES.githubApp} in ${inputs.region} already holds GitHub App ${describeApp(existing)}.\n`,
  );
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
  const choice = await chooseApp(existing, inputs, deps, yes);

  if (choice === "keep") {
    deps.out("Keeping the existing App.\n");
    if ((await store.read(SECRET_NAMES.githubWebhook)) === undefined) {
      deps.out(
        `Warning: ${SECRET_NAMES.githubWebhook} is missing, so the gateway can't verify webhooks. ` +
          "Run setup again and create a new App to fix it.\n",
      );
    }
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
    },
    webhookSecret,
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

async function writeConfig(inputs: SetupInputs, deps: SetupDeps, yes: boolean): Promise<void> {
  if (await deps.files.exists(deps.configPath)) {
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
  1. ${install}
  2. Connect a model provider. Bedrock works with no key; for others run
     pnpm lgtmoose auth <claude|codex|cursor|api-key>   (coming in NIC-824)
  3. Deploy, which also turns on the App's webhook:
     pnpm lgtmoose deploy   (coming in NIC-803)
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
    const inputs = await resolveSetupInputs(flags, deps.prompter);
    const { slug } = await setUpApp(inputs, deps, flags.yes);
    await writeConfig(inputs, deps, flags.yes);
    return { exitCode: 0, stdout: nextSteps(slug), stderr: "" };
  } catch (error) {
    if (isPromptCancel(error)) return { exitCode: 130, stdout: "", stderr: "Setup cancelled.\n" };
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `Setup failed: ${message}\n` };
  }
}
