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
  type Tier,
} from "@lgtmoose/config";
import { CLI, loadDeployConfig } from "../paths.js";
import { isPromptCancel } from "../setup/prompter.js";
import type { SetupFiles } from "../setup/setup.js";
import {
  CONTEXT_VARIANT,
  type BedrockAccess,
  type InferenceProfile,
  type ModelAccess,
} from "./bedrock.js";
import { codexLogin, LoginInterrupted } from "./codex-login.js";
import { RECOVERY_DAYS, type CredentialStore } from "./credential-store.js";
import { CommandNotFound, type InteractiveRunner, type SignalTrap } from "./process.js";
import { errorMessage } from "../errors.js";

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
 * Shown before storing a credential tied to a person's subscription: what the vendor's terms
 * and docs say, summed up from docs/providers.md, which quotes them and links the sources
 * (NIC-820). The first line is the same for every vendor.
 */
export const PLAN_CREDENTIAL_HEADER =
  "Warning: this stores a credential tied to one person's subscription plan.";

/** A plan credential `isPlanCredential` recognises, as harness/auth. */
type PlanCredentialKind =
  "claude-code/oauth-token" | "codex/chatgpt-login" | "codex/access-token" | "cursor-agent/api-key";

const PLAN_CREDENTIAL_ADVICE: Record<PlanCredentialKind, string> = {
  "claude-code/oauth-token": `Pro, Max and Ultra plans fall under Anthropic's consumer terms, which forbid making your
account available to anyone else; Team and Enterprise fall under its commercial terms.
Neither says a bot may review other people's pull requests on one person's seat. Anthropic
documents API keys for automation. On a Max, Ultra or Team plan, a key from the plan's linked
Console organization may draw on the plan's monthly API credits (see docs/providers.md for
when they apply; requests stop when they run out). To use one, set this
provider's auth to "api-key" in lgtmoose.config.ts, run the command below, then ${CLI} deploy:
  ${CLI} auth api-key --provider anthropic
Bedrock (auth "bedrock", then ${CLI} deploy) needs no key at all.`,
  "codex/chatgpt-login": `OpenAI's terms forbid sharing account credentials or making your account available to
others. OpenAI recommends an API key for automation: set this provider's auth to "api-key"
in lgtmoose.config.ts, run the command below, then ${CLI} deploy:
  ${CLI} auth api-key --provider openai
On ChatGPT Business or Enterprise, a Codex access token is the documented alternative
(auth "access-token", ${CLI} auth codex --access-token, then ${CLI} deploy).`,
  "codex/access-token": `A Codex access token acts as the workspace user who created it. OpenAI documents it for
trusted runners on Business and Enterprise workspaces. Create it while signed in as a
dedicated bot user in the workspace, not as a person, and keep the deployment private.
An OpenAI API key avoids the question: set this provider's auth to "api-key", run the
command below, then ${CLI} deploy:
  ${CLI} auth api-key --provider openai`,
  "cursor-agent/api-key": `A user API key bills to that person's Cursor plan, and Cursor says logins mustn't be
shared. Cursor's service accounts (Enterprise) are made for automation: set this provider's
auth to "service-account" in lgtmoose.config.ts, store a service-account key, then
${CLI} deploy. Without Enterprise, a claude-code provider on Bedrock, or one with an
Anthropic API key (${CLI} auth api-key --provider anthropic), avoids the question.`,
};

/** The warning for one plan credential. */
export function planCredentialWarning(provider: Pick<ProviderConfig, "harness" | "auth">): string {
  const kind = `${provider.harness}/${provider.auth}`;
  if (!(kind in PLAN_CREDENTIAL_ADVICE)) {
    // isPlanCredential grew without advice here: fail loudly rather than warn vaguely.
    throw new Error(`No plan-credential advice for ${kind}. Add it to PLAN_CREDENTIAL_ADVICE.`);
  }
  const advice = PLAN_CREDENTIAL_ADVICE[kind as PlanCredentialKind];
  return (
    `\n${PLAN_CREDENTIAL_HEADER}\nLGTMoose will use it to review everyone's pull requests in ` +
    `the repositories the App is installed on.\n${advice}\n` +
    "Details and sources: docs/providers.md. Go on only if your plan's terms allow this use.\n\n"
  );
}

export const AUTH_HELP = `Usage: lgtmoose auth <method> [options]

Stores a model provider's credential in AWS Secrets Manager, in the region from
lgtmoose.config.ts, as lgtmoose/provider/<id>. Values are read without echo, never printed,
and not kept on disk (codex's temporary sign-in directory is deleted straight after).

Methods:
  claude                    Run \`claude setup-token\`, then paste the token it prints
  codex                     Run \`codex login\` (ChatGPT sign-in) and upload its auth.json
  cursor                    Paste a Cursor user or service-account API key
  bedrock                   Check the Bedrock models each tier pins can be called here. Aliases such
                            as sonnet are only hinted at; pin model ids to check them. Stores nothing
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
        return `That's an Anthropic API key. Use ${CLI} auth api-key --provider anthropic.`;
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
        return `That's a Claude Code OAuth token. Use ${CLI} auth claude --paste.`;
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
  /** This command as typed, for messages that say to run it again. Holds no secrets: none are flags. */
  rerun: string;
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
      rerun: [CLI, "auth", ...argv].join(" "),
    };
  } catch (error) {
    throw new UsageError(errorMessage(error));
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
    throw new UsageError(`auth remove needs the provider id: ${CLI} auth remove <id>.`);
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
    throw new AuthError(`No config at ${deps.configPath}. Run ${CLI} setup first.`);
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
  deps.out(planCredentialWarning(provider));
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
  flags: Flags,
): Promise<string> {
  const { outcome, tagError } = await deps
    .credentials(config.region)
    .put({ providerId: provider.id, harness: provider.harness, auth: provider.auth }, value, {
      rerun: flags.rerun,
    });
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
    `added "${provider.id}" to lgtmoose.config.ts, run ${CLI} deploy.\n`
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
  return store(config, provider, await ask(KINDS.claudeOauth, deps), deps, flags);
}

async function authCodex(flags: Flags, deps: AuthDeps): Promise<string> {
  const config = await loadConfig(deps);
  const auth: AuthMethod = flags.accessToken ? "access-token" : "chatgpt-login";
  const provider = pickProvider(config, [{ harness: "codex", auth }], flags.id, "auth codex");
  await confirmPlanCredential(provider, flags, deps);
  if (flags.accessToken) {
    return store(config, provider, await ask(KINDS.codexAccessToken, deps), deps, flags);
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
  return store(config, provider, authJson, deps, flags);
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
  return store(config, provider, await ask(KINDS.cursorKey, deps), deps, flags);
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
  return store(config, provider, await ask(kind, deps), deps, flags);
}

async function authBedrock(flags: Flags, deps: AuthDeps): Promise<{ text: string; ok: boolean }> {
  const config = await loadConfig(deps);
  const region = config.region;
  const bedrockProviders = config.providers.filter((p) => p.auth === "bedrock");
  if (flags.id !== undefined && !bedrockProviders.some((p) => p.id === flags.id)) {
    throw new AuthError(`No provider "${flags.id}" with bedrock auth in lgtmoose.config.ts.`);
  }
  const checked = bedrockProviders.filter((p) => flags.id === undefined || p.id === flags.id);
  const tiers = checked.flatMap((provider) =>
    TIERS.flatMap((tier) => {
      const configured = modelFor(provider, tier);
      return configured === undefined ? [] : [{ provider, tier, model: parseModel(configured) }];
    }),
  );

  deps.out(`Checking Anthropic model access on Bedrock in ${region}…\n`);
  // Legacy models cost a call each, so only the ones a tier pins are checked.
  const legacyToCheck = new Set(
    tiers.flatMap(({ model }) => (model.kind === "id" ? [model.id] : [])),
  );
  const bedrock = deps.bedrock(region);
  // One after the other: Bedrock's control plane throttles bursts, and if the profile listing
  // fails there's no point starting the availability checks.
  const profiles = await bedrock.inferenceProfiles();
  const models = await bedrock.anthropicModels({ legacyToCheck });
  const facts: BedrockFacts = { models, profiles, region, reach: reachOf(models, profiles) };
  const current = models.filter((model) => !model.legacy);
  // Usable means callable here too: access granted, and an id this region can call it by.
  const usable = current.filter((model) => model.usable);
  const callable = usable.filter((model) => (facts.reach.get(model.modelId)?.length ?? 0) > 0);
  const maybe = usable.filter((model) => facts.reach.get(model.modelId) === undefined);
  const lines = current
    .toSorted((a, b) => a.modelId.localeCompare(b.modelId))
    .map((model) => modelLine(model, facts));

  const tierLines: string[] = [];
  const problems: Problem[] = [];
  let anyChecked = false;
  let anyBlocked = false;
  for (const { provider, tier, model } of tiers) {
    const verdict = tierVerdict(model, provider.id, tier, facts);
    if (verdict.state !== "not checked") anyChecked = true;
    if (verdict.state === "blocked") {
      anyBlocked = true;
      problems.push(...verdict.problems);
    }
    tierLines.push(
      `  ${verdict.state.padEnd(11)}  ${provider.id} ${tier} (${model.configured}): ${verdictDetail(verdict)}`,
    );
  }

  const notes: string[] = [];
  if (bedrockProviders.length === 0) {
    notes.push(
      'No provider in lgtmoose.config.ts uses bedrock yet. Add { id: "bedrock", harness: ' +
        '"claude-code", auth: "bedrock" } to providers to use it.',
    );
  }
  // The tiers decide. With none to check, the best this can say is whether anything is usable.
  const nothingUsable = !anyChecked && callable.length === 0 && maybe.length === 0;
  const ok = !anyBlocked && !nothingUsable;
  if (nothingUsable) {
    notes.push(
      current.length === 0
        ? `Bedrock offers no Anthropic models in ${region}.`
        : "This account can't use any Anthropic model here.",
    );
    for (const model of current) problems.push(...reachProblems(model, facts));
  }
  if (profiles === undefined) {
    notes.push(
      "Couldn't list inference profiles (this AWS identity lacks bedrock:ListInferenceProfiles), " +
        "so profile ids weren't checked. On-demand ids were.",
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
  // Each problem printed above has one fix; print each fix once.
  const fixes = [...new Set(problems.map((problem) => fixText(problem.fix, region)))];
  if (nothingUsable && current.length === 0) fixes.push(fixText({ kind: "region" }, region));
  // After the diagnosis notes, so what's wrong comes before what to do.
  const fixBlock = fixes.length > 0 ? ["", "To fix:", ...fixes.map((fix) => `  - ${fix}`)] : [];
  return {
    text: [
      "Anthropic models (ids to pin):",
      ...lines,
      ...tierBlock,
      "",
      ...notes,
      ...fixBlock,
      "",
    ].join("\n"),
    ok,
  };
}

/**
 * The families Claude Code's aliases follow. Claude Code (or an ANTHROPIC_DEFAULT_*_MODEL
 * override) picks the model at runtime, so all auth can check is that the family has one.
 * `opusplan` plans with Opus and works with Sonnet.
 */
const ALIAS_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  haiku: ["haiku"],
  sonnet: ["sonnet"],
  opus: ["opus"],
  opusplan: ["opus", "sonnet"],
};

/** A Claude Code modifier such as `[1m]` (the 1M-token context window): `sonnet[1m]`. */
const MODIFIER = /\[[^\]]*\]$/;

/** A Bedrock model id, bare (`anthropic.…`) or through a cross-region profile (`us.anthropic.…`). */
const BEDROCK_ID = /^(?:([a-z-]+)\.)?(anthropic\..+)$/;

type ParsedModel = { configured: string } & (
  | { kind: "alias"; families: readonly string[] }
  | { kind: "id"; id: string; prefix: string | undefined }
  | { kind: "unchecked"; why: string }
  | { kind: "invalid"; why: string }
);

/** What a tier's configured model value means under Bedrock auth. */
function parseModel(configured: string): ParsedModel {
  const value = configured.replace(MODIFIER, "");
  const families = ALIAS_FAMILIES[value];
  if (families !== undefined) return { configured, kind: "alias", families };
  if (value === "default") {
    return { configured, kind: "unchecked", why: "Claude Code's default model, chosen at runtime" };
  }
  if (value.startsWith("arn:")) {
    return { configured, kind: "unchecked", why: "an ARN, which this can't look up" };
  }
  const match = BEDROCK_ID.exec(value);
  const id = match?.[2];
  if (id === undefined) {
    return {
      configured,
      kind: "invalid",
      why:
        "not a Bedrock model id: under bedrock auth, use anthropic.… or a profile id such as " +
        "us.anthropic.…",
    };
  }
  // A context-window variant (`…:0:200k`) shares its base model's access.
  return { configured, kind: "id", id: id.replace(CONTEXT_VARIANT, ""), prefix: match?.[1] };
}

/** Bedrock doesn't always say how a model is called; then assume it can be. */
const supports = (model: ModelAccess, type: string) =>
  model.inferenceTypes.length === 0 || model.inferenceTypes.includes(type);

const NEEDS_PROFILE_LIST = "needs bedrock:ListInferenceProfiles";

/**
 * The ids this region can call a model by: its own id when it's callable on demand, else the
 * system-defined inference profiles Bedrock lists for it here. Empty when there's no way to
 * call it here; undefined when the profiles couldn't be listed.
 */
function pinnableIds(
  model: ModelAccess,
  profiles: readonly InferenceProfile[] | undefined,
): string[] | undefined {
  if (supports(model, "ON_DEMAND")) return [model.modelId];
  if (profiles === undefined) return undefined;
  return profiles.filter((profile) => profile.modelId === model.modelId).map((p) => p.id);
}

/** Each model's pinnable ids, worked out once. */
function reachOf(
  models: readonly ModelAccess[],
  profiles: readonly InferenceProfile[] | undefined,
): ReadonlyMap<string, string[] | undefined> {
  return new Map(models.map((model) => [model.modelId, pinnableIds(model, profiles)]));
}

/**
 * One concrete reason a tier or model can't run here, as printed, and its one fix. The fix
 * comes straight from the problem, never from guessing at the reason.
 */
interface Problem {
  text: string;
  fix: Fix;
}

type Fix =
  | { kind: "access" }
  | { kind: "region" }
  | { kind: "recheck" }
  | { kind: "wait" }
  | { kind: "profiles" }
  | { kind: "id"; provider: string; tier: Tier };

/** The sentence a fix prints. Equal sentences are printed once. */
function fixText(fix: Fix, region: string): string {
  switch (fix.kind) {
    case "access":
      return (
        `Request model access (and accept its agreement) in the Bedrock console for ${region}, ` +
        "then run this again."
      );
    case "wait":
      return "Wait a few minutes for the model agreement to go through, then run this again.";
    case "region":
      return "Pick another region, or a model that has an inference profile here.";
    case "recheck":
      return "Run this again; if a model still can't be checked, pin a different one.";
    case "profiles":
      return "Grant bedrock:ListInferenceProfiles to check inference profile ids.";
    default:
      return `Fix the id in ${fix.provider}.models.${fix.tier}.`;
  }
}

/** Bedrock's own problems with a model, as tier or list problems. */
function modelProblems(model: ModelAccess): Problem[] {
  return model.problems.map((problem) => ({ text: problem.text, fix: { kind: problem.fix } }));
}

const NO_ROUTE = "no way to call it here (no on-demand use, no inference profile in this region)";
const PROFILE_ONLY: Problem = {
  text: `callable only through an inference profile (${NEEDS_PROFILE_LIST})`,
  fix: { kind: "profiles" },
};

/**
 * What stops a model being called here, most decisive first: not offered in this region, or
 * no way to call it here, is the only fix that matters, so access or agreement problems are
 * left out then. Otherwise Bedrock's own problems; for a usable model, whether its route is
 * known. Empty when it can be called.
 */
function reachProblems(model: ModelAccess, facts: BedrockFacts): Problem[] {
  const notHere = modelProblems(model).filter((problem) => problem.fix.kind === "region");
  if (notHere.length > 0) return notHere;
  const ids = facts.reach.get(model.modelId);
  if (ids?.length === 0) return [{ text: NO_ROUTE, fix: { kind: "region" } }];
  if (!model.usable) return modelProblems(model);
  return ids === undefined ? [PROFILE_ONLY] : [];
}

/** One line of the model list: whether it's usable here, and the ids to pin if so. */
function modelLine(model: ModelAccess, facts: BedrockFacts): string {
  const problems = reachProblems(model, facts);
  if (problems.length === 0) {
    return `  ok       ${(facts.reach.get(model.modelId) ?? []).join(" or ")}`;
  }
  // Callable, just through a route this identity can't list: not known to be blocked.
  const label = problems.every((p) => p === PROFILE_ONLY) ? "unknown" : "blocked";
  return `  ${label}  ${model.modelId}: ${problems.map((p) => p.text).join(", ")}`;
}

type Verdict =
  | { state: "ok"; detail: string }
  | { state: "not checked"; detail: string }
  /** A blocked tier always says what's wrong, which is also how its fixes are found. */
  | { state: "blocked"; subject: string; problems: readonly [Problem, ...Problem[]] };

function blocked(subject: string, problems: readonly Problem[]): Verdict {
  const [first, ...rest] = problems;
  if (first === undefined) throw new Error(`blocked without a problem: ${subject}`);
  return { state: "blocked", subject, problems: [first, ...rest] };
}

/** What a verdict prints after the tier's name. */
function verdictDetail(verdict: Verdict): string {
  if (verdict.state !== "blocked") return verdict.detail;
  const problems = verdict.problems.map((p) => p.text).join(", ");
  return verdict.subject === "" ? problems : `${verdict.subject}: ${problems}`;
}

interface BedrockFacts {
  models: readonly ModelAccess[];
  /** Undefined when they couldn't be listed. */
  profiles: readonly InferenceProfile[] | undefined;
  region: string;
  /** Each model's pinnable ids (`pinnableIds`). */
  reach: ReadonlyMap<string, string[] | undefined>;
}

/** Whether a tier's model can run on Bedrock here. "not checked" is reported, never failed. */
function tierVerdict(
  model: ParsedModel,
  provider: string,
  tier: Tier,
  facts: BedrockFacts,
): Verdict {
  switch (model.kind) {
    case "unchecked":
      return { state: "not checked", detail: model.why };
    case "invalid":
      return blocked("", [{ text: model.why, fix: { kind: "id", provider, tier } }]);
    case "alias":
      return familyVerdict(model.families, tier, facts);
    default:
      return idVerdict(model.id, model.prefix, { kind: "id", provider, tier }, facts);
  }
}

/**
 * Aliases can't be checked from here: Claude Code picks the model at runtime, perhaps not one
 * this would pick. So the verdict is informational, except that a family with no callable
 * model at all is certain to fail; then each member's own problems say why.
 */
function familyVerdict(families: readonly string[], tier: Tier, facts: BedrockFacts): Verdict {
  const hints: string[] = [];
  for (const family of families) {
    const pattern = new RegExp(`^anthropic\\.claude-(?:[\\d-]+-)?${family}(?:-|$)`);
    const members = facts.models.filter((m) => !m.legacy && pattern.test(m.modelId));
    const ids: string[] = [];
    let unknown = 0;
    for (const model of members) {
      if (!model.usable) continue;
      const pins = facts.reach.get(model.modelId);
      if (pins === undefined) unknown += 1;
      else ids.push(...pins);
    }
    if (ids.length === 0 && unknown === 0) {
      const subject = `no usable ${family} model in ${facts.region}`;
      if (members.length === 0) {
        return blocked(subject, [
          { text: `Bedrock offers no ${family} model here`, fix: { kind: "region" } },
        ]);
      }
      return blocked(
        subject,
        members.flatMap((model) =>
          reachProblems(model, facts).map((p) => ({ ...p, text: `${model.modelId} ${p.text}` })),
        ),
      );
    }
    const more = unknown > 0 ? ` (and ${unknown} more: ${NEEDS_PROFILE_LIST})` : "";
    hints.push(`usable ${family} ids here: ${ids.join(", ") || "none listed"}${more}`);
  }
  return {
    state: "not checked",
    detail:
      `Claude Code picks the ${families.join(" and ")} model at runtime. Pin a model id in ` +
      `models.${tier} to have it checked (${hints.join("; ")})`,
  };
}

/** A concrete id passes only if this region can call it exactly as written. */
function idVerdict(
  id: string,
  prefix: string | undefined,
  /** The fix for an id pinned the wrong way: this tier's entry in its provider's models. */
  idFix: Fix,
  facts: BedrockFacts,
): Verdict {
  const access = facts.models.find((candidate) => candidate.modelId === id);
  if (access === undefined) {
    return blocked(id, [{ text: `isn't offered in ${facts.region}`, fix: { kind: "region" } }]);
  }
  const subject = prefix === undefined ? id : `${prefix}.${id}`;
  const ids = facts.reach.get(access.modelId);
  // Not offered here, or no way to call it here: that alone decides, whatever else is wrong.
  let route = modelProblems(access).filter((problem) => problem.fix.kind === "region");
  if (route.length === 0 && ids?.length === 0)
    route = [{ text: NO_ROUTE, fix: { kind: "region" } }];
  if (route.length > 0) return blocked(subject, route);

  // The pin is checked whether or not access is granted, so both show in one run.
  const pin: Problem[] = [];
  const wrongPin = (text: string) => {
    if (ids === undefined) {
      pin.push({ text, fix: idFix }, { text: NEEDS_PROFILE_LIST, fix: { kind: "profiles" } });
    } else {
      pin.push({ text: `${text}; use ${ids.join(" or ")}`, fix: idFix });
    }
  };
  let unchecked = false;
  if (prefix === undefined) {
    if (!supports(access, "ON_DEMAND")) wrongPin("can only be called through an inference profile");
  } else if (!supports(access, "INFERENCE_PROFILE")) {
    // Bedrock says it has no profiles at all: any profile id is wrong, listed or not.
    wrongPin("has no inference profile");
  } else if (facts.profiles === undefined) {
    unchecked = true;
  } else if (!facts.profiles.some((profile) => profile.id === subject && profile.modelId === id)) {
    wrongPin(`isn't an inference profile ${facts.region} can call`);
  }

  const problems = [...(access.usable ? [] : modelProblems(access)), ...pin];
  if (problems.length > 0) return blocked(subject, problems);
  const legacy = access.legacy ? " (legacy: Bedrock is retiring it)" : "";
  if (unchecked)
    return { state: "not checked", detail: `${subject}${legacy}: ${NEEDS_PROFILE_LIST}` };
  return { state: "ok", detail: `${subject}${legacy}` };
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
      lines.push(`${head}  missing: run ${CLI} auth (see --help)`);
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
    const message = errorMessage(error);
    return { exitCode: 1, stdout: "", stderr: `auth ${method} failed: ${message}\n` };
  }
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
