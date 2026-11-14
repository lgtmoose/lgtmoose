import { parseArgs } from "node:util";
import {
  PROVIDER_ID_PATTERN,
  SECRET_NAMES,
  TIERS,
  isPlanCredential,
  modelFor,
  providerNeedsSecret,
  type AuthMethod,
  type DeployConfig,
  type Harness,
  type ProviderConfig,
} from "@lgtmoose/config";
import { loadDeployConfig } from "../paths.js";
import { isPromptCancel } from "../setup/prompter.js";
import type { SetupFiles } from "../setup/setup.js";
import { CONTEXT_VARIANT, type BedrockAccess, type ModelAccess } from "./bedrock.js";
import { codexLogin, LoginInterrupted } from "./codex-login.js";
import { RECOVERY_DAYS, type CredentialStore } from "./credential-store.js";
import { CommandNotFound, type InteractiveRunner, type SignalTrap } from "./process.js";

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
  cursor: ["id", "acceptVendorTerms"],
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
    if (id !== undefined && !PROVIDER_ID_PATTERN.test(id)) {
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
  provider: ProviderConfig,
  flags: Flags,
  deps: AuthDeps,
): Promise<void> {
  if (!isPlanCredential(provider)) return;
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
  const { outcome, tagError } = await deps
    .credentials(config.region)
    .put({ providerId: provider.id, harness: provider.harness, auth: provider.auth }, value);
  const name = SECRET_NAMES.provider(provider.id);
  const verb = { created: "Stored", updated: "Replaced", restored: "Restored and replaced" }[
    outcome
  ];
  const tagNote =
    tagError === undefined
      ? ""
      : `Warning: the value is stored, but its tags couldn't be updated (${tagError}), so ` +
        "auth list may describe it wrongly. Run this again to fix them.\n";
  return (
    `${verb} the ${provider.auth} credential for provider "${provider.id}" in ${name} ` +
    `(${config.region}).\n${tagNote}Sandbox tasks started from now on use it. If you just ` +
    `added "${provider.id}" to lgtmoose.config.ts, run pnpm lgtmoose deploy.\n`
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
  await confirmPlanCredential(provider, flags, deps);
  if (!flags.paste) {
    deps.out(
      "\nRunning claude setup-token. Sign in, then copy the token it prints. " +
        "You'll paste it here next; LGTMoose doesn't read Claude's output.\n\n",
    );
    const code = await deps.run("claude", ["setup-token"], {}).catch((error: unknown) => {
      throw error instanceof CommandNotFound
        ? new AuthError(`${error.message} Install Claude Code, or paste a token with --paste.`)
        : error;
    });
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
  await confirmPlanCredential(provider, flags, deps);
  if (flags.accessToken) {
    return store(config, provider, await ask(KINDS.codexAccessToken, deps), deps);
  }
  deps.out(
    "\nRunning codex login in a temporary CODEX_HOME. It's deleted as soon as codex " +
      "finishes, whatever happens; the sign-in is uploaded from memory.\n\n",
  );
  const authJson = await codexLogin({
    run: deps.run,
    trapSignals: deps.trapSignals,
    deviceAuth: flags.deviceAuth,
    ...(deps.tmpRoot === undefined ? {} : { tmpRoot: deps.tmpRoot }),
  }).catch((error: unknown) => {
    throw error instanceof CommandNotFound
      ? new AuthError(`${error.message} Install the Codex CLI (npm install -g @openai/codex).`)
      : error;
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
  await confirmPlanCredential(provider, flags, deps);
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
  // Legacy models only matter when a tier pins one, so they're left out of the list.
  const current = models.filter((model) => !model.legacy);
  const usable = current.filter((model) => model.usable);
  const lines = current
    .toSorted((a, b) => a.modelId.localeCompare(b.modelId))
    .map((model) =>
      model.usable
        ? `  ok       ${model.modelId}`
        : `  blocked  ${model.modelId}: ${model.problems.join(", ")}`,
    );

  // The models the configured providers will actually ask for, tier by tier.
  const checked = bedrockProviders.filter((p) => flags.id === undefined || p.id === flags.id);
  const tierLines: string[] = [];
  let tiersOk = true;
  for (const provider of checked) {
    for (const tier of TIERS) {
      const model = modelFor(provider, tier);
      if (model === undefined) continue;
      const verdict = tierVerdict(model, models, config.region);
      if (verdict.state === "blocked") tiersOk = false;
      tierLines.push(
        `  ${verdict.state.padEnd(11)}  ${provider.id} ${tier} (${model}): ${verdict.detail}`,
      );
    }
  }

  const notes: string[] = [];
  if (bedrockProviders.length === 0) {
    notes.push(
      'No provider in lgtmoose.config.ts uses bedrock yet. Add { id: "bedrock", harness: ' +
        '"claude-code", auth: "bedrock" } to providers to use it.',
    );
  }
  if (!tiersOk) {
    notes.push(
      "A configured tier can't run here. Request model access in the Bedrock console " +
        `(${config.region}), or set that tier in the provider's models to one marked ok.`,
    );
  }
  if (usable.length === 0) {
    notes.unshift(
      current.length === 0
        ? `Bedrock offers no Anthropic models in ${config.region}. Pick another region.`
        : "This account can't call any Anthropic model here. Request model access in the " +
            `Bedrock console (${config.region}), then run this again.`,
    );
  }
  if (models.some((model) => model.usable && model.callerAuthorized === false)) {
    notes.push(
      "Your own AWS identity isn't allowed to invoke some of these models. That's about you, " +
        "not the sandbox: deploy gives the sandbox task role its own Bedrock access.",
    );
  }
  notes.push("Bedrock needs no stored secret: sandbox tasks sign in with their IAM role.");
  const tierBlock = tierLines.length > 0 ? ["", "Configured tiers:", ...tierLines] : [];
  return {
    text: ["Anthropic models:", ...lines, ...tierBlock, "", ...notes, ""].join("\n"),
    ok: usable.length > 0 && tiersOk,
  };
}

/**
 * Model values Claude Code resolves itself, to a Bedrock model of its choosing (or the one an
 * ANTHROPIC_DEFAULT_*_MODEL override names). auth can't know which, so it doesn't guess.
 */
const CLAUDE_CODE_ALIASES = new Set(["default", "haiku", "sonnet", "opus", "opusplan"]);

/** A Claude Code modifier such as `[1m]` (the 1M-token context window): `sonnet[1m]`. */
const MODIFIER = /\[[^\]]*\]$/;

/** A Bedrock model id, bare (`anthropic.…`) or through a cross-region profile (`us.anthropic.…`). */
const BEDROCK_ID = /^(?:([a-z-]+)\.)?(anthropic\..+)$/;

/**
 * The cross-region profile prefixes a region may call. Undefined for regions this doesn't
 * know, where the prefix isn't checked. `global.` works from anywhere.
 */
function profilePrefixes(region: string): readonly string[] | undefined {
  if (region.startsWith("us-gov-")) return ["us-gov"];
  if (region.startsWith("us-")) return ["us"];
  if (region.startsWith("eu-")) return ["eu"];
  if (region === "ap-northeast-1" || region === "ap-northeast-3") return ["apac", "jp"];
  if (region === "ap-southeast-2" || region === "ap-southeast-4") return ["apac", "au"];
  if (region.startsWith("ap-")) return ["apac"];
  return undefined;
}

type TierState = "ok" | "blocked" | "not checked";

/**
 * Whether a tier's model can run on Bedrock here. "not checked" covers what auth can't
 * resolve the way the harness will (aliases, ARNs, unknown ids); it's reported, never failed.
 */
function tierVerdict(
  configured: string,
  models: readonly ModelAccess[],
  region: string,
): { state: TierState; detail: string } {
  const notChecked = (detail: string) => ({ state: "not checked" as const, detail });
  const model = configured.replace(MODIFIER, "");
  if (CLAUDE_CODE_ALIASES.has(model)) {
    return notChecked(
      "an alias Claude Code resolves itself; pin a Bedrock model id in models to have it checked",
    );
  }
  if (model.startsWith("arn:")) return notChecked("an ARN, which this can't look up");
  const match = BEDROCK_ID.exec(model);
  const prefix = match?.[1];
  const id = match?.[2]?.replace(CONTEXT_VARIANT, "");
  if (id === undefined) return notChecked("not a Bedrock model id");

  const access = models.find((candidate) => candidate.modelId === id);
  if (access === undefined) return { state: "blocked", detail: `${id} isn't offered in ${region}` };
  if (!access.usable) {
    return { state: "blocked", detail: `${id} is ${access.problems.join(", ")}` };
  }
  const legacy = access.legacy ? " (legacy: Bedrock is retiring it)" : "";
  const supports = (type: string) =>
    access.inferenceTypes.length === 0 || access.inferenceTypes.includes(type);
  if (prefix === undefined) {
    if (!supports("ON_DEMAND")) {
      const geo = profilePrefixes(region)?.[0] ?? "global";
      return {
        state: "blocked",
        detail: `${id} can only be called through an inference profile, such as ${geo}.${id}`,
      };
    }
    return { state: "ok", detail: `${id}${legacy}` };
  }
  if (!supports("INFERENCE_PROFILE")) {
    return { state: "blocked", detail: `${id} has no cross-region inference profile` };
  }
  if (prefix !== "global") {
    const allowed = profilePrefixes(region);
    if (allowed === undefined) {
      return notChecked(
        `${id} is usable, but this can't tell if ${region} may call ${prefix}. profiles`,
      );
    }
    if (!allowed.includes(prefix)) {
      return {
        state: "blocked",
        detail: `${region} can't call ${prefix}. profiles; use ${allowed.join(". or ")}. or global.`,
      };
    }
  }
  return { state: "ok", detail: `${prefix}.${id}${legacy}` };
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
  const result = await deps.credentials(config.region).remove(id, RECOVERY_DAYS);
  const restore = `Running auth for "${id}" before then restores it with the new value.\n`;
  const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  switch (result.status) {
    case "missing":
      throw new AuthError(`${name} doesn't exist in ${config.region}.`);
    case "scheduled": {
      const when =
        result.deletionDate === undefined
          ? `in ${RECOVERY_DAYS} days`
          : `on ${utc(result.deletionDate)}`;
      return `Scheduled ${name} for deletion ${when}. ${restore}`;
    }
    default: {
      // Secrets Manager only says when the earlier remove ran, not its recovery window.
      const since = result.scheduledSince === undefined ? "" : ` on ${utc(result.scheduledSince)}`;
      return (
        `${name} was already scheduled for deletion by an earlier remove${since}; that ` +
        `schedule still applies (Secrets Manager deletes it 7 to 30 days after). ${restore}`
      );
    }
  }
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
      // A LoginInterrupted can say the temporary directory couldn't be removed.
      const detail = error instanceof LoginInterrupted ? ` ${error.message}` : "";
      return { exitCode: 130, stdout: "", stderr: `auth cancelled. Nothing stored.${detail}\n` };
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
