import { TIERS, modelFor, type DeployConfig, type ProviderConfig, type Tier } from "./deploy.js";
import { BEDROCK_MODEL_ID, MODEL_MODIFIER, isModelAlias } from "./models.js";

/**
 * Checks that the models a deployment is configured with can be called (NIC-1121), so a model
 * that isn't available on the account fails at deploy or in the health check, not on the first
 * real PR. `lgtmoose deploy` runs every check it can; the scheduled health check runs the ones
 * that need no credential value (Bedrock, which the task's IAM role signs).
 *
 * This module only plans the checks and judges their answers. Each caller brings the calls:
 * the AWS SDK for Bedrock, `fetch` for the API-key providers. A result never holds a credential.
 */

/** How a model is checked. */
export type ModelCheckKind = "bedrock" | "anthropic-api" | "openai-api";

/** One model to check, with every tier of the provider that uses it. */
export interface ModelToCheck {
  providerId: string;
  kind: ModelCheckKind;
  /** As configured, without a `[1m]`-style modifier. */
  model: string;
  tiers: Tier[];
}

/** A provider's model that isn't checked, and why. */
export interface SkippedModel {
  providerId: string;
  tiers: Tier[];
  /** Undefined when the harness picks its own model (Codex and Cursor by default). */
  model: string | undefined;
  reason: string;
}

/** Whether a model can be called, as a check found. */
export type ModelCheckStatus =
  /** It can be called. */
  | "ok"
  /** It can't: `problem` says why and `fix` what to do. */
  | "unavailable"
  /**
   * An ACTIVE inference profile whose model access couldn't be read, because this region doesn't
   * offer the model itself: nothing says it can't be called, so it isn't reported unavailable.
   */
  | "unverified"
  /** The check itself failed (throttled, no permission to ask): nothing is known. */
  | "unknown";

export interface ModelCheckResult extends ModelToCheck {
  status: ModelCheckStatus;
  /** Why it can't be called, or why the check couldn't run. Never a credential. */
  problem?: string;
  /** What fixes it, for `unavailable`. */
  fix?: string;
}

const SUBSCRIPTION_REASON =
  "not checked: a subscription sign-in has no cheap way to ask, so the first run shows it";

/**
 * Which models to check for each provider, and which are skipped. A model several tiers share is
 * checked once. Claude Code's aliases (`sonnet`, `opus`) resolve to a model ID only at run time,
 * and ARNs (application inference profiles) are taken as given, so neither is checked.
 */
export function planModelChecks(config: Pick<DeployConfig, "providers">): {
  checks: ModelToCheck[];
  skipped: SkippedModel[];
} {
  const checks: ModelToCheck[] = [];
  const skipped: SkippedModel[] = [];
  for (const provider of config.providers) {
    const kind = checkKind(provider);
    const byModel = new Map<string | undefined, Tier[]>();
    for (const tier of TIERS) {
      const configured = modelFor(provider, tier);
      const model = configured?.replace(MODEL_MODIFIER, "");
      byModel.set(model, [...(byModel.get(model) ?? []), tier]);
    }
    for (const [model, tiers] of byModel) {
      const skip = (reason: string) =>
        skipped.push({ providerId: provider.id, tiers, model, reason });
      if (typeof kind !== "string") {
        skip(kind.reason);
      } else if (model === undefined) {
        skip("not checked: the CLI picks its own model");
      } else if (isModelAlias(model)) {
        skip("not checked: an alias, which Claude Code resolves to a model ID when it runs");
      } else if (model.startsWith("arn:")) {
        skip("not checked: an ARN is used as given");
      } else {
        checks.push({ providerId: provider.id, kind, model, tiers });
      }
    }
  }
  return { checks, skipped };
}

function checkKind(
  provider: Pick<ProviderConfig, "harness" | "auth">,
): ModelCheckKind | { reason: string } {
  const claude = provider.harness === "claude-code" || provider.harness === "agent-sdk";
  if (claude && provider.auth === "bedrock") return "bedrock";
  if (claude && provider.auth === "api-key") return "anthropic-api";
  if (provider.harness === "codex" && provider.auth === "api-key") return "openai-api";
  if (provider.auth === "vertex") {
    return { reason: "not checked: Vertex AI isn't checked yet, so the first run shows it" };
  }
  if (provider.harness === "cursor-agent") {
    return { reason: "not checked: Cursor has no model check, so the first run shows it" };
  }
  return { reason: SUBSCRIPTION_REASON };
}

/** The AWS console's host for a region's partition: commercial, GovCloud or China. */
function consoleHost(region: string): string {
  if (region.startsWith("us-gov-")) return "console.amazonaws-us-gov.com";
  if (region.startsWith("cn-")) return "console.amazonaws.cn";
  return `${region}.console.aws.amazon.com`;
}

/** The Bedrock console page where model access is turned on, for a region. */
export function bedrockModelAccessUrl(region: string): string {
  return `https://${consoleHost(region)}/bedrock/home?region=${region}#/modelaccess`;
}

/** How the CLI is run, for fix hints. The CLI's own `CLI` is this. */
export const CLI_COMMAND = "pnpm lgtmoose";

/** Regions whose cross-region profiles have a country prefix of their own. */
const COUNTRY_PROFILES: Readonly<Record<string, string>> = {
  "ap-northeast-1": "jp",
  "ap-northeast-3": "jp",
  "ap-southeast-2": "au",
  "ap-southeast-4": "au",
};

/**
 * The cross-region inference profile prefix for a region's geography (`us.`, `us-gov.`, `eu.`,
 * `jp.`, `au.`, `apac.`), or undefined where Bedrock has none: then only `global.` is suggested.
 */
function profilePrefix(region: string): string | undefined {
  const country = COUNTRY_PROFILES[region];
  if (country !== undefined) return country;
  if (region.startsWith("us-gov-")) return "us-gov";
  if (region.startsWith("us-") || region.startsWith("ca-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return undefined;
}

/** Profile IDs to suggest for a bare model ID in a region. */
function profileSuggestion(model: string, region: string): string {
  const geo = profilePrefix(region);
  return geo === undefined ? `global.${model}` : `${geo}.${model} or global.${model}`;
}

/** An AWS answer that says the thing asked about doesn't exist. */
export class BedrockNotFound extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "BedrockNotFound";
  }
}

/**
 * The Bedrock control-plane calls a check makes. Each throws `BedrockNotFound` when Bedrock says
 * the ID doesn't exist here, and anything else when the call itself failed.
 */
export interface BedrockModelApi {
  /** GetInferenceProfile: its status. */
  inferenceProfile(id: string): Promise<{ status: string | undefined }>;
  /** GetFoundationModel: how it can be called (`ON_DEMAND`, `INFERENCE_PROFILE`). */
  foundationModel(id: string): Promise<{ inferenceTypes: string[] | undefined }>;
  /** GetFoundationModelAvailability: what the account may do with it in this region. */
  availability(id: string): Promise<{
    region: string | undefined;
    entitlement: string | undefined;
    agreement: string | undefined;
    /** Bedrock's reason, when the agreement is in ERROR. */
    agreementError?: string | undefined;
  }>;
}

/** Context-window variants such as `…-v1:0:200k` share their base model's access. */
const CONTEXT_VARIANT = /:\d+k$/;

/** One line, short, with no control characters: an AWS or API message as a problem detail. */
export function checkDetail(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name === "Error" ? "" : `${error.name}: `}${error.message}`
      : String(error);
  let clean = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    clean += code < 0x20 || code === 0x7f ? " " : char;
  }
  clean = clean.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

/**
 * Whether a Bedrock model ID can be called in `region`: an inference profile (`us.…`,
 * `global.…`) must exist there and be active; a bare foundation model must exist and take
 * on-demand calls; and either way the account must have model access and the model's agreement
 * accepted. These are account-level facts, so they hold for the sandbox's task role too.
 */
export async function checkBedrockModel(
  api: BedrockModelApi,
  check: ModelToCheck,
  region: string,
): Promise<ModelCheckResult> {
  const access = bedrockModelAccessUrl(region);
  const result = (status: ModelCheckStatus, problem?: string, fix?: string): ModelCheckResult => ({
    ...check,
    status,
    ...(problem === undefined ? {} : { problem }),
    ...(fix === undefined ? {} : { fix }),
  });
  const match = BEDROCK_MODEL_ID.exec(check.model);
  if (match?.[2] === undefined) {
    return result(
      "unavailable",
      `${check.model} isn't a Bedrock model ID`,
      "use anthropic.… or an inference profile ID such as us.anthropic.…",
    );
  }
  // Claude Code calls the configured ID, a `:200k`-style variant included, so that's what must
  // take on-demand calls; access and agreements are the base model's.
  const configured = match[2];
  const foundation = configured.replace(CONTEXT_VARIANT, "");
  const listProfiles = `${CLI_COMMAND} auth bedrock --id ${check.providerId}`;
  try {
    if (match[1] !== undefined) {
      let profile;
      try {
        profile = await api.inferenceProfile(check.model);
      } catch (error) {
        if (!(error instanceof BedrockNotFound)) throw error;
        return result(
          "unavailable",
          `Bedrock has no inference profile ${check.model} in ${region}`,
          `check the ID against the profiles ${listProfiles} lists for ${region}`,
        );
      }
      if (profile.status !== undefined && profile.status !== "ACTIVE") {
        return result(
          "unavailable",
          `the inference profile ${check.model} is ${profile.status.toLowerCase()} in ${region}`,
          "pin an active profile",
        );
      }
    } else {
      let model;
      try {
        model = await api.foundationModel(configured);
      } catch (error) {
        if (!(error instanceof BedrockNotFound)) throw error;
        return result(
          "unavailable",
          `Bedrock has no model ${check.model} in ${region}`,
          `check the ID, or use an inference profile ID such as ${profileSuggestion(foundation, region)}`,
        );
      }
      const types = model.inferenceTypes ?? [];
      if (types.length > 0 && !types.includes("ON_DEMAND")) {
        if (types.includes("INFERENCE_PROFILE")) {
          return result(
            "unavailable",
            `${check.model} can only be called through an inference profile in ${region}`,
            `pin a profile ID instead, such as ${profileSuggestion(foundation, region)}`,
          );
        }
        return result(
          "unavailable",
          `${check.model} can only be called with provisioned throughput in ${region}, which LGTMoose doesn't use`,
          foundation === configured
            ? `pin a model that takes on-demand calls: ${listProfiles} lists them`
            : `pin the base model ${foundation} if it takes on-demand calls: ${listProfiles} lists those that do`,
        );
      }
    }
    // A profile routes to other regions, so its model needn't be offered (or even known) in this
    // one: an ACTIVE profile settles that, and only the account's access and agreement are read.
    // Where this region doesn't offer the model, Bedrock reports its access as NOT_AVAILABLE
    // whatever the account has, so it can't be read here. The profile is ACTIVE and nothing says
    // the model can't be called, so it is `unverified`: not unavailable, which clears the alarm.
    const profile = match[1] !== undefined;
    const unreadable = () =>
      result(
        "unverified",
        `model access to ${foundation} couldn't be read in ${region}, which doesn't offer it itself`,
      );
    let availability;
    try {
      availability = await api.availability(foundation);
    } catch (error) {
      if (!(error instanceof BedrockNotFound)) throw error;
      if (profile) return unreadable();
      return result("unavailable", `Bedrock has no model ${foundation} in ${region}`, access);
    }
    const offeredHere = availability.region === undefined || availability.region === "AVAILABLE";
    if (profile && !offeredHere) return unreadable();
    if (!offeredHere) {
      return result(
        "unavailable",
        `${foundation} isn't offered in ${region}`,
        "deploy to a region that offers it, or pin another model",
      );
    }
    if (availability.entitlement !== undefined && availability.entitlement !== "AVAILABLE") {
      return result(
        "unavailable",
        `model access to ${foundation} isn't granted in ${region}`,
        `request access in the Bedrock console: ${access}`,
      );
    }
    if (availability.agreement === "ERROR") {
      const why = availability.agreementError?.trim();
      return result(
        "unavailable",
        `the agreement for ${foundation} failed in ${region}${why === undefined || why === "" ? "" : `: ${checkDetail(why)}`}`,
        `accept it again in the Bedrock console, ${access}`,
      );
    }
    if (availability.agreement !== undefined && availability.agreement !== "AVAILABLE") {
      const state = availability.agreement.toLowerCase().replaceAll("_", " ");
      return result(
        "unavailable",
        `the agreement for ${foundation} is ${state} in ${region}`,
        availability.agreement === "PENDING"
          ? "wait for it to go through, then check again"
          : `accept it in the Bedrock console: ${access}`,
      );
    }
    return result("ok");
  } catch (error) {
    return result("unknown", `couldn't check: ${checkDetail(error)}`);
  }
}

/**
 * A GET with headers, answering the status, and the body only for a 401: the one answer whose
 * meaning depends on it (a bad key, or a restricted key without model reads).
 */
export type StatusGet = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body?: string }>;

/**
 * Whether a 401's body says the key itself is bad: OpenAI's `invalid_api_key` or "Incorrect API
 * key", Anthropic's `authentication_error` ("invalid x-api-key"). A 401 for missing scopes, as
 * OpenAI gives a restricted key without `api.model.read`, isn't: that key may work for reviews.
 */
export function badKey(body: string | undefined): boolean {
  if (body === undefined) return false;
  let error: { code?: unknown; type?: unknown; message?: unknown } | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: typeof error };
    error = parsed.error;
  } catch {
    return false;
  }
  if (error === undefined || error === null) return false;
  const message = typeof error.message === "string" ? error.message : "";
  if (/insufficient permissions|missing scopes?/i.test(message)) return false;
  return (
    error.code === "invalid_api_key" ||
    error.type === "authentication_error" ||
    /\b(?:invalid|incorrect) (?:x-)?api[ -]key\b|api key (?:is )?invalid/i.test(message)
  );
}

/**
 * Whether an API key can use a model: one authenticated `GET /v1/models/<model>`, which is free
 * on both APIs. `key` goes only into the request's header.
 */
export async function checkApiModel(
  get: StatusGet,
  check: ModelToCheck,
  key: string,
): Promise<ModelCheckResult> {
  const anthropic = check.kind === "anthropic-api";
  const vendor = anthropic ? "Anthropic" : "OpenAI";
  const url = anthropic
    ? `https://api.anthropic.com/v1/models/${encodeURIComponent(check.model)}`
    : `https://api.openai.com/v1/models/${encodeURIComponent(check.model)}`;
  const result = (status: ModelCheckStatus, problem?: string, fix?: string): ModelCheckResult => ({
    ...check,
    status,
    ...(problem === undefined ? {} : { problem }),
    ...(fix === undefined ? {} : { fix }),
  });
  const storeKey = `store a working key with ${CLI_COMMAND} auth api-key --provider ${anthropic ? "anthropic" : "openai"} --id ${check.providerId}`;
  const trimmed = key.trim();
  // A header can't hold control characters: fetch would refuse it with an error quoting the key.
  if (!headerSafe(trimmed)) {
    return result("unavailable", "the stored key has invalid characters", storeKey);
  }
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": trimmed, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${trimmed}` };
  let status: number;
  let body: string | undefined;
  try {
    ({ status, body } = await get(url, headers));
  } catch (error) {
    // Only the error's name: a fetch error's message can quote the request's headers, key and all.
    const name = error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : "Error";
    return result("unknown", `couldn't check: the request to the ${vendor} API failed (${name})`);
  }
  if (status >= 200 && status < 300) return result("ok");
  if (status === 404) {
    return result(
      "unavailable",
      `the ${vendor} API has no model ${check.model} for this key`,
      "check the model name in lgtmoose.config.ts",
    );
  }
  if (status === 401 && badKey(body)) {
    return result("unavailable", `the ${vendor} API refused the stored key (HTTP 401)`, storeKey);
  }
  if (status === 401 || status === 403) {
    // A restricted key without model reads gets this here, and may still work for reviews.
    return result(
      "unknown",
      `couldn't check: the ${vendor} API answered HTTP ${status} without calling the key invalid, so it may lack only the permission to read models`,
    );
  }
  return result("unknown", `couldn't check: the ${vendor} API answered HTTP ${status}`);
}

/** Whether a key is printable ASCII only: no line break, NUL or other control character. */
function headerSafe(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** A failed check as one line for a person: provider, tiers, model, where, why and the fix. */
export function describeModelProblem(result: ModelCheckResult): string {
  const tiers = result.tiers.join(", ");
  // No full stop straight after a URL: it would be copied with it.
  const end = result.fix !== undefined && /https?:\/\/\S+$/.test(result.fix) ? "" : ".";
  const fix = result.fix === undefined ? "" : ` Fix: ${result.fix}${end}`;
  const problem = result.problem ?? result.status;
  const stop = /[.!?]$/.test(problem) ? "" : ".";
  return `${result.providerId} (${tiers}): ${result.model}: ${problem}${stop}${fix}`;
}

/**
 * Whether an AWS error says the model or profile ID doesn't exist here: a
 * `ResourceNotFoundException`, or a `ValidationException` about the identifier itself. Any other
 * validation error is a problem with the request, so the check is `unknown`, not `unavailable`.
 */
export function isBedrockNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ResourceNotFoundException") return true;
  return (
    error.name === "ValidationException" &&
    ABOUT_THE_ID.test(error.message) &&
    NOT_AN_ID.test(error.message)
  );
}

/** A message about the model or profile identifier, as Bedrock words it. */
const ABOUT_THE_ID = /\b(?:model|profile) (?:identifier|id)\b|\binference profile\b/i;
/** …that says the identifier isn't one ("The provided model identifier is invalid."). */
const NOT_AN_ID =
  /\b(?:invalid|not valid|unknown|not found|could not resolve|couldn't resolve|doesn't exist|does not exist)\b/i;

/** The parts of `@aws-sdk/client-bedrock` the checks use, passed in so this package needs no SDK. */
export interface BedrockSdk {
  client: { send(command: unknown): Promise<unknown> };
  GetInferenceProfileCommand: new (input: { inferenceProfileIdentifier: string }) => unknown;
  GetFoundationModelCommand: new (input: { modelIdentifier: string }) => unknown;
  GetFoundationModelAvailabilityCommand: new (input: { modelId: string }) => unknown;
}

/**
 * Options for the checks' `BedrockClient`: a few retries for throttling, and limits so a call
 * that hangs can't use up the health check's run.
 */
export function bedrockClientOptions(region: string) {
  return {
    region,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
  };
}

/** A `BedrockModelApi` on the AWS SDK's Bedrock client. */
export function bedrockModelApi(sdk: BedrockSdk): BedrockModelApi {
  const send = async <T>(command: unknown): Promise<T> => {
    try {
      return (await sdk.client.send(command)) as T;
    } catch (error) {
      if (error instanceof Error && isBedrockNotFound(error)) {
        throw new BedrockNotFound(error.message);
      }
      throw error;
    }
  };
  return {
    async inferenceProfile(id) {
      const reply = await send<{ status?: string }>(
        new sdk.GetInferenceProfileCommand({ inferenceProfileIdentifier: id }),
      );
      return { status: reply.status };
    },
    async foundationModel(id) {
      const reply = await send<{ modelDetails?: { inferenceTypesSupported?: string[] } }>(
        new sdk.GetFoundationModelCommand({ modelIdentifier: id }),
      );
      return { inferenceTypes: reply.modelDetails?.inferenceTypesSupported };
    },
    async availability(id) {
      const reply = await send<{
        regionAvailability?: string;
        entitlementAvailability?: string;
        agreementAvailability?: { status?: string; errorMessage?: string };
      }>(new sdk.GetFoundationModelAvailabilityCommand({ modelId: id }));
      return {
        region: reply.regionAvailability,
        entitlement: reply.entitlementAvailability,
        agreement: reply.agreementAvailability?.status,
        agreementError: reply.agreementAvailability?.errorMessage,
      };
    },
  };
}

/** The most of a 401's body read: enough for an API's error object. */
const MAX_ERROR_BODY = 4096;

/** A `StatusGet` on `fetch`: a 401's body (cut short) and no other, giving up after 10 s. */
export const fetchStatus: StatusGet = async (url, headers) => {
  const reply = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (reply.status !== 401) {
    await reply.body?.cancel();
    return { status: reply.status };
  }
  const body = (await reply.text()).slice(0, MAX_ERROR_BODY);
  return { status: reply.status, body };
};
