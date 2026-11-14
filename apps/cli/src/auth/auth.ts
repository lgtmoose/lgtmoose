import { parseArgs } from "node:util";
import {
  PLAN_AUTH_METHODS,
  SECRET_NAMES,
  providerNeedsSecret,
  type AuthMethod,
  type DeployConfig,
  type Harness,
  type ProviderConfig,
} from "@lgtmoose/config";
import { loadDeployConfig } from "../paths.js";
import { isPromptCancel } from "../setup/prompter.js";
import type { SetupFiles } from "../setup/setup.js";
import type { BedrockAccess } from "./bedrock.js";
import { codexLogin, LoginInterrupted } from "./codex-login.js";
import type { CredentialStore } from "./credential-store.js";
import type { InteractiveRunner, SignalTrap } from "./process.js";

/** The prompts auth asks. Matches @inquirer/prompts, so tests can script the answers. */
export interface AuthPrompter {
  /** Reads a value without echoing it. */
  password(options: {
    message: string;
    validate?: (value: string) => true | string;
  }): Promise<string>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
}

/** Everything `lgtmoose auth` touches outside its own process. */
export interface AuthDeps {
  configPath: string;
  files: Pick<SetupFiles, "exists" | "loadConfig">;
  prompter: AuthPrompter;
  credentials: (region: string) => CredentialStore;
  bedrock: (region: string) => BedrockAccess;
  run: InteractiveRunner;
  trapSignals: SignalTrap;
  /** Where `auth codex` puts its temporary CODEX_HOME. The OS temp dir by default. */
  tmpRoot?: string;
  /** Progress for the person. Never receives a secret. */
  out: (text: string) => void;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Shown before storing a credential tied to a person's subscription. NIC-820 (the vendor-terms
 * spike) replaces this with its findings and links to the primary sources.
 */
export const PLAN_CREDENTIAL_WARNING = `
Warning: this stores a credential tied to a personal subscription plan.
LGTMoose will use it to review pull requests for everyone who opens them in the repositories
the App is installed on. Vendors' terms on automated, shared or team-wide use of personal plans
differ and change often; some don't allow it. Check the current terms of your plan before you
go on. An API key, Bedrock or a team service account avoids the question.
`;

export const AUTH_HELP = `Usage: lgtmoose auth <method> [options]

Stores a model provider's credential in AWS Secrets Manager, in the region from
lgtmoose.config.ts, as lgtmoose/provider/<id>. Values are read without echo, never printed,
and not kept on disk (codex's temporary sign-in directory is deleted straight after).

Methods:
  claude                    Run \`claude setup-token\`, then paste the token it prints
  codex                     Run \`codex login\` (ChatGPT sign-in) and upload its auth.json
  cursor                    Paste a Cursor user or service-account API key
  bedrock                   Check this account can call Anthropic models on Bedrock. Stores nothing
  api-key --provider <p>    Paste an API key: anthropic or openai
  list                      Show every provider credential, and which providers lack one
  remove <id>               Delete provider <id>'s credential (recoverable for 7 days)

Options:
  --id <id>                 The provider in lgtmoose.config.ts to store it for. Needed only
                            when more than one provider uses this method
  --paste                   claude: skip \`claude setup-token\` and paste a token you have
  --device-auth             codex: sign in with a device code instead of a browser
  --access-token            codex: paste a Codex access token instead of signing in
  --accept-vendor-terms     Don't ask before storing a subscription plan credential
  -y, --yes                 remove: don't ask for confirmation
  -h, --help
`;

class UsageError extends Error {}

/** Thrown for a problem the person can fix; shown as-is. */
class AuthError extends Error {}

const RECOVERY_DAYS = 7;

/** A harness and auth method a command can store a credential for. */
interface Target {
  harness: Harness;
  auth: AuthMethod;
}

/** What one kind of credential looks like, so a pasted value can be checked before storing. */
interface CredentialKind {
  label: string;
  validate: (value: string) => true | string;
}

const noSpaces = (value: string): true | string => {
  if (value.trim() === "") return "Paste the value, or press Ctrl+C to stop.";
  if (/\s/.test(value.trim())) return "That has spaces in it. Paste just the one value.";
  return true;
};

const KINDS = {
  claudeOauth: {
    label: "Claude Code OAuth token",
    validate: (value) => {
      const plain = noSpaces(value);
      if (plain !== true) return plain;
      if (value.trim().startsWith("sk-ant-api")) {
        return "That's an Anthropic API key. Use pnpm lgtmoose auth api-key --provider anthropic.";
      }
      if (!value.trim().startsWith("sk-ant-")) {
        return "That doesn't look like a token from claude setup-token (sk-ant-…).";
      }
      return true;
    },
  },
  anthropicKey: {
    label: "Anthropic API key",
    validate: (value) => {
      const plain = noSpaces(value);
      if (plain !== true) return plain;
      if (value.trim().startsWith("sk-ant-oat")) {
        return "That's a Claude Code OAuth token. Use pnpm lgtmoose auth claude --paste.";
      }
      return value.trim().startsWith("sk-ant-")
        ? true
        : "That doesn't look like an Anthropic API key (sk-ant-…).";
    },
  },
  openaiKey: {
    label: "OpenAI API key",
    validate: (value) => {
      const plain = noSpaces(value);
      if (plain !== true) return plain;
      return value.trim().startsWith("sk-")
        ? true
        : "That doesn't look like an OpenAI API key (sk-…).";
    },
  },
  codexAccessToken: { label: "Codex access token", validate: noSpaces },
  cursorKey: { label: "Cursor API key", validate: noSpaces },
} satisfies Record<string, CredentialKind>;

interface Flags {
  id: string | undefined;
  provider: string | undefined;
  paste: boolean;
  deviceAuth: boolean;
  accessToken: boolean;
  acceptVendorTerms: boolean;
  yes: boolean;
  help: boolean;
  positionals: string[];
}

function parseFlags(argv: readonly string[]): Flags {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        id: { type: "string" },
        provider: { type: "string" },
        paste: { type: "boolean" },
        "device-auth": { type: "boolean" },
        "access-token": { type: "boolean" },
        "accept-vendor-terms": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
      },
    });
    return {
      id: values.id,
      provider: values.provider,
      paste: values.paste === true,
      deviceAuth: values["device-auth"] === true,
      accessToken: values["access-token"] === true,
      acceptVendorTerms: values["accept-vendor-terms"] === true,
      yes: values.yes === true,
      help: values.help === true,
      positionals,
    };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Flags only some methods take; any other method rejects them, so a typo isn't ignored. */
const METHOD_FLAGS: Record<string, readonly (keyof Flags)[]> = {
  claude: ["id", "paste", "acceptVendorTerms"],
  codex: ["id", "deviceAuth", "accessToken", "acceptVendorTerms"],
  cursor: ["id"],
  bedrock: ["id"],
  "api-key": ["id", "provider"],
  list: [],
  remove: ["yes"],
};

const FLAG_NAMES: Partial<Record<keyof Flags, string>> = {
  id: "--id",
  provider: "--provider",
  paste: "--paste",
  deviceAuth: "--device-auth",
  accessToken: "--access-token",
  acceptVendorTerms: "--accept-vendor-terms",
  yes: "--yes",
};

/** The same rule as a provider `id` in lgtmoose.config.ts. */
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;

function checkFlags(method: string, flags: Flags): void {
  const allowed = METHOD_FLAGS[method];
  if (allowed === undefined) throw new UsageError(`Unknown auth method "${method}".`);
  for (const [key, name] of Object.entries(FLAG_NAMES) as [keyof Flags, string][]) {
    const value = flags[key];
    const set = typeof value === "boolean" ? value : value !== undefined;
    if (set && !allowed.includes(key)) {
      throw new UsageError(`auth ${method} doesn't take ${name}.`);
    }
  }
  const extra = flags.positionals.slice(method === "remove" ? 2 : 1);
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`);
  if (method === "remove" && flags.positionals[1] === undefined) {
    throw new UsageError("auth remove needs the provider id: lgtmoose auth remove <id>.");
  }
  for (const id of [flags.id, method === "remove" ? flags.positionals[1] : undefined]) {
    if (id !== undefined && !PROVIDER_ID.test(id)) {
      throw new UsageError(`"${id}" isn't a provider id: lowercase letters, digits and hyphens.`);
    }
  }
  if (method === "api-key" && flags.provider !== "anthropic" && flags.provider !== "openai") {
    throw new UsageError("auth api-key needs --provider anthropic or --provider openai.");
  }
  if (flags.deviceAuth && flags.accessToken) {
    throw new UsageError("--device-auth signs in; --access-token pastes a token. Pick one.");
  }
}

async function loadConfig(deps: AuthDeps): Promise<DeployConfig> {
  const config = await loadDeployConfig(deps.files, deps.configPath);
  if (config === undefined) {
    throw new AuthError(`No config at ${deps.configPath}. Run pnpm lgtmoose setup first.`);
  }
  return config;
}

const describeTargets = (targets: readonly Target[]) =>
  targets.map((t) => `{ harness: "${t.harness}", auth: "${t.auth}" }`).join(" or ");

/**
 * The provider in the config to store a credential for: the one `--id` names, or the only one
 * that uses one of `targets`.
 */
function pickProvider(
  config: DeployConfig,
  targets: readonly Target[],
  id: string | undefined,
  command: string,
): ProviderConfig {
  const fits = (provider: ProviderConfig) =>
    targets.some((t) => t.harness === provider.harness && t.auth === provider.auth);
  if (id !== undefined) {
    const named = config.providers.find((provider) => provider.id === id);
    if (named === undefined) {
      throw new AuthError(
        `lgtmoose.config.ts has no provider with id "${id}". Known ids: ` +
          `${config.providers.map((p) => p.id).join(", ")}.`,
      );
    }
    if (!fits(named)) {
      throw new AuthError(
        `Provider "${id}" uses ${named.harness} with ${named.auth} auth, which ${command} ` +
          `doesn't store. It stores ${describeTargets(targets)}.`,
      );
    }
    return named;
  }
  const matches = config.providers.filter(fits);
  const [only] = matches;
  if (only === undefined) {
    throw new AuthError(
      `No provider in lgtmoose.config.ts uses ${describeTargets(targets)}. Add one to ` +
        `providers, for example { id: "${targets[0]?.harness ?? "provider"}", ` +
        `harness: "${targets[0]?.harness}", auth: "${targets[0]?.auth}" }, then run this again.`,
    );
  }
  if (matches.length > 1) {
    throw new AuthError(
      `More than one provider fits: ${matches.map((p) => p.id).join(", ")}. ` +
        "Pick one with --id <id>.",
    );
  }
  return only;
}

/** Shows the warning for plan credentials and asks before going on. */
async function confirmPlanCredential(
  auth: AuthMethod,
  flags: Flags,
  deps: AuthDeps,
): Promise<void> {
  if (!PLAN_AUTH_METHODS.includes(auth)) return;
  deps.out(PLAN_CREDENTIAL_WARNING);
  if (flags.acceptVendorTerms) {
    deps.out("Going on: --accept-vendor-terms was given.\n");
    return;
  }
  const go = await deps.prompter.confirm({
    message: "Your plan's terms allow this use. Store the credential?",
    default: false,
  });
  if (!go) throw new AuthError("Nothing stored.");
}

async function store(
  config: DeployConfig,
  provider: ProviderConfig,
  value: string,
  deps: AuthDeps,
): Promise<string> {
  const outcome = await deps
    .credentials(config.region)
    .put({ providerId: provider.id, harness: provider.harness, auth: provider.auth }, value);
  const name = SECRET_NAMES.provider(provider.id);
  const verb = { created: "Stored", updated: "Replaced", restored: "Restored and replaced" }[
    outcome
  ];
  return (
    `${verb} the ${provider.auth} credential for provider "${provider.id}" in ${name} ` +
    `(${config.region}).\nSandbox tasks started from now on use it. If you just added ` +
    `"${provider.id}" to lgtmoose.config.ts, run pnpm lgtmoose deploy.\n`
  );
}

/** Reads a credential without echo. Trimmed, as the sandbox trims it too. */
async function ask(kind: CredentialKind, deps: AuthDeps): Promise<string> {
  const value = await deps.prompter.password({
    message: `Paste the ${kind.label}:`,
    validate: kind.validate,
  });
  return value.trim();
}

async function authClaude(flags: Flags, deps: AuthDeps): Promise<string> {
  const config = await loadConfig(deps);
  const provider = pickProvider(
    config,
    [{ harness: "claude-code", auth: "oauth-token" }],
    flags.id,
    "auth claude",
  );
  await confirmPlanCredential(provider.auth, flags, deps);
  if (!flags.paste) {
    deps.out(
      "\nRunning claude setup-token. Sign in, then copy the token it prints. " +
        "You'll paste it here next; LGTMoose doesn't read Claude's output.\n\n",
    );
    const code = await deps.run("claude", ["setup-token"], {});
    if (code !== 0) {
      throw new AuthError(
        `claude setup-token exited with code ${code ?? "unknown"}. Nothing stored. ` +
          "If you already have a token, run this again with --paste.",
      );
    }
  }
  return store(config, provider, await ask(KINDS.claudeOauth, deps), deps);
}

async function authCodex(flags: Flags, deps: AuthDeps): Promise<string> {
  const config = await loadConfig(deps);
  const auth: AuthMethod = flags.accessToken ? "access-token" : "chatgpt-login";
  const provider = pickProvider(config, [{ harness: "codex", auth }], flags.id, "auth codex");
  await confirmPlanCredential(provider.auth, flags, deps);
  if (flags.accessToken) {
    return store(config, provider, await ask(KINDS.codexAccessToken, deps), deps);
  }
  deps.out(
    "\nRunning codex login in a temporary CODEX_HOME. It's deleted as soon as the sign-in " +
      "is uploaded, or if anything fails.\n\n",
  );
  const authJson = await codexLogin({
    run: deps.run,
    trapSignals: deps.trapSignals,
    deviceAuth: flags.deviceAuth,
    ...(deps.tmpRoot === undefined ? {} : { tmpRoot: deps.tmpRoot }),
  });
  return store(config, provider, authJson, deps);
}

async function authCursor(flags: Flags, deps: AuthDeps): Promise<string> {
  const config = await loadConfig(deps);
  const provider = pickProvider(
    config,
    [
      { harness: "cursor-agent", auth: "api-key" },
      { harness: "cursor-agent", auth: "service-account" },
    ],
    flags.id,
    "auth cursor",
  );
  return store(config, provider, await ask(KINDS.cursorKey, deps), deps);
}

async function authApiKey(flags: Flags, deps: AuthDeps): Promise<string> {
  // checkFlags allows only these two.
  const vendor = flags.provider === "openai" ? "openai" : "anthropic";
  const config = await loadConfig(deps);
  const targets: Target[] =
    vendor === "anthropic"
      ? [
          { harness: "claude-code", auth: "api-key" },
          { harness: "agent-sdk", auth: "api-key" },
        ]
      : [{ harness: "codex", auth: "api-key" }];
  const provider = pickProvider(config, targets, flags.id, `auth api-key --provider ${vendor}`);
  const kind = vendor === "anthropic" ? KINDS.anthropicKey : KINDS.openaiKey;
  return store(config, provider, await ask(kind, deps), deps);
}

async function authBedrock(flags: Flags, deps: AuthDeps): Promise<{ text: string; ok: boolean }> {
  const config = await loadConfig(deps);
  const bedrockProviders = config.providers.filter((p) => p.auth === "bedrock");
  if (flags.id !== undefined && !bedrockProviders.some((p) => p.id === flags.id)) {
    throw new AuthError(`No provider "${flags.id}" with bedrock auth in lgtmoose.config.ts.`);
  }
  deps.out(`Checking Anthropic model access on Bedrock in ${config.region}…\n`);
  const models = await deps.bedrock(config.region).anthropicModels();
  const usable = models.filter((model) => model.usable);
  const lines = models
    .toSorted((a, b) => a.modelId.localeCompare(b.modelId))
    .map((model) =>
      model.usable
        ? `  ok       ${model.modelId}`
        : `  blocked  ${model.modelId}: ${model.problems.join(", ")}`,
    );
  const notes: string[] = [];
  if (bedrockProviders.length === 0) {
    notes.push(
      'No provider in lgtmoose.config.ts uses bedrock yet. Add { id: "bedrock", harness: ' +
        '"claude-code", auth: "bedrock" } to providers to use it.',
    );
  }
  notes.push("Bedrock needs no stored secret: sandbox tasks sign in with their IAM role.");
  if (usable.length === 0) {
    notes.unshift(
      models.length === 0
        ? `Bedrock offers no Anthropic models in ${config.region}. Pick another region.`
        : "This account can't call any Anthropic model here. Request model access in the " +
            `Bedrock console (${config.region}), then run this again.`,
    );
  }
  return {
    text: [...lines, "", ...notes, ""].join("\n"),
    ok: usable.length > 0,
  };
}

async function authList(deps: AuthDeps): Promise<string> {
  const config = await loadConfig(deps);
  const stored = await deps.credentials(config.region).list();
  const byName = new Map(stored.map((secret) => [secret.name, secret]));
  const width = Math.max(...config.providers.map((p) => p.id.length));
  const date = (when: Date | undefined) =>
    when === undefined ? "" : `, changed ${when.toISOString().slice(0, 10)}`;

  const lines = [`Providers in lgtmoose.config.ts (${config.region}):`];
  for (const provider of config.providers) {
    const head = `  ${provider.id.padEnd(width)}  ${provider.harness}/${provider.auth}`;
    if (!providerNeedsSecret(provider)) {
      lines.push(`${head}  no secret needed: uses the task's IAM role`);
      continue;
    }
    const secret = byName.get(SECRET_NAMES.provider(provider.id));
    if (secret === undefined) {
      lines.push(`${head}  missing: run pnpm lgtmoose auth (see --help)`);
    } else if (
      (secret.auth !== undefined && secret.auth !== provider.auth) ||
      (secret.harness !== undefined && secret.harness !== provider.harness)
    ) {
      lines.push(
        `${head}  stored for ${secret.harness ?? "?"}/${secret.auth ?? "?"}, not ` +
          `${provider.harness}/${provider.auth}: run auth for it again`,
      );
    } else {
      lines.push(`${head}  stored${date(secret.lastChanged)}`);
    }
  }
  const configured = new Set(config.providers.map((p) => SECRET_NAMES.provider(p.id)));
  const orphans = stored.filter((secret) => !configured.has(secret.name));
  if (orphans.length > 0) {
    lines.push("", "Stored, but no provider in lgtmoose.config.ts uses them:");
    for (const secret of orphans) {
      const what = secret.harness === undefined ? "" : ` (${secret.harness}/${secret.auth ?? "?"})`;
      lines.push(`  ${secret.name}${what}${date(secret.lastChanged)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function authRemove(flags: Flags, deps: AuthDeps): Promise<string> {
  const id = flags.positionals[1] ?? "";
  const config = await loadConfig(deps);
  const name = SECRET_NAMES.provider(id);
  const inUse = config.providers.some((p) => p.id === id && providerNeedsSecret(p));
  if (inUse) {
    deps.out(
      `Provider "${id}" is still in lgtmoose.config.ts. Its reviews fail until you store a new ` +
        "credential or remove it from the config, and deploy refuses to run.\n",
    );
  }
  if (!flags.yes) {
    const go = await deps.prompter.confirm({
      message: `Delete ${name} in ${config.region}?`,
      default: false,
    });
    if (!go) throw new AuthError("Nothing deleted.");
  }
  const outcome = await deps.credentials(config.region).remove(id, RECOVERY_DAYS);
  if (outcome === "missing") throw new AuthError(`${name} doesn't exist in ${config.region}.`);
  return (
    `Scheduled ${name} for deletion in ${RECOVERY_DAYS} days. Running auth for "${id}" before ` +
    "then restores it with the new value.\n"
  );
}

/** `lgtmoose auth`. */
export async function runAuth(
  argv: readonly string[],
  getDeps: () => Promise<AuthDeps>,
): Promise<CommandResult> {
  let flags: Flags;
  try {
    flags = parseFlags(argv);
    if (flags.help) return { exitCode: 0, stdout: AUTH_HELP, stderr: "" };
    if (flags.positionals[0] === undefined) return { exitCode: 1, stdout: "", stderr: AUTH_HELP };
    checkFlags(flags.positionals[0], flags);
  } catch (error) {
    if (error instanceof UsageError) {
      return { exitCode: 1, stdout: "", stderr: `${error.message}\n\n${AUTH_HELP}` };
    }
    throw error;
  }

  const method = flags.positionals[0];
  const deps = await getDeps();
  try {
    switch (method) {
      case "bedrock": {
        const { text, ok } = await authBedrock(flags, deps);
        return ok
          ? { exitCode: 0, stdout: text, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: text };
      }
      case "claude":
        return ok(await authClaude(flags, deps));
      case "codex":
        return ok(await authCodex(flags, deps));
      case "cursor":
        return ok(await authCursor(flags, deps));
      case "api-key":
        return ok(await authApiKey(flags, deps));
      case "list":
        return ok(await authList(deps));
      default:
        return ok(await authRemove(flags, deps));
    }
  } catch (error) {
    if (isPromptCancel(error) || error instanceof LoginInterrupted) {
      return { exitCode: 130, stdout: "", stderr: "auth cancelled. Nothing stored.\n" };
    }
    if (error instanceof UsageError) {
      return { exitCode: 1, stdout: "", stderr: `${error.message}\n\n${AUTH_HELP}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout: "", stderr: `auth ${method} failed: ${message}\n` };
  }
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
