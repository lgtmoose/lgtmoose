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

/** The Bedrock console page where model access is turned on, for a region. */
export function bedrockModelAccessUrl(region: string): string {
  return `https://${region}.console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`;
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
  /** GetInferenceProfile: its status and the foundation models it routes to. */
  inferenceProfile(id: string): Promise<{ status: string | undefined; modelIds: string[] }>;
  /** GetFoundationModel: how it can be called (`ON_DEMAND`, `INFERENCE_PROFILE`). */
  foundationModel(id: string): Promise<{ inferenceTypes: string[] | undefined }>;
  /** GetFoundationModelAvailability: what the account may do with it in this region. */
  availability(id: string): Promise<{
    region: string | undefined;
    entitlement: string | undefined;
    agreement: string | undefined;
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
  const foundation = match[2].replace(CONTEXT_VARIANT, "");
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
          `check the ID against the profiles listed in ${region} (lgtmoose auth bedrock lists them)`,
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
        model = await api.foundationModel(foundation);
      } catch (error) {
        if (!(error instanceof BedrockNotFound)) throw error;
        return result(
          "unavailable",
          `Bedrock has no model ${check.model} in ${region}`,
          `check the ID, or use an inference profile ID such as us.${check.model}`,
        );
      }
      if (
        model.inferenceTypes !== undefined &&
        model.inferenceTypes.length > 0 &&
        !model.inferenceTypes.includes("ON_DEMAND")
      ) {
        return result(
          "unavailable",
          `${check.model} can only be called through an inference profile in ${region}`,
          `pin a profile ID instead, such as us.${check.model} or global.${check.model}`,
        );
      }
    }
    let availability;
    try {
      availability = await api.availability(foundation);
    } catch (error) {
      if (!(error instanceof BedrockNotFound)) throw error;
      return result("unavailable", `Bedrock has no model ${foundation} in ${region}`, access);
    }
    if (availability.region !== undefined && availability.region !== "AVAILABLE") {
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

/** A GET with headers, answering only the status: an API-key check never reads a body. */
export type StatusGet = (url: string, headers: Record<string, string>) => Promise<number>;

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
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": key.trim(), "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key.trim()}` };
  const result = (status: ModelCheckStatus, problem?: string, fix?: string): ModelCheckResult => ({
    ...check,
    status,
    ...(problem === undefined ? {} : { problem }),
    ...(fix === undefined ? {} : { fix }),
  });
  let status: number;
  try {
    status = await get(url, headers);
  } catch (error) {
    return result("unknown", `couldn't check: ${checkDetail(error)}`);
  }
  if (status >= 200 && status < 300) return result("ok");
  if (status === 404) {
    return result(
      "unavailable",
      `the ${vendor} API has no model ${check.model} for this key`,
      "check the model name in lgtmoose.config.ts",
    );
  }
  if (status === 401 || status === 403) {
    return result(
      "unavailable",
      `the ${vendor} API refused the stored key (HTTP ${status})`,
      `store a working key with lgtmoose auth api-key --provider ${anthropic ? "anthropic" : "openai"}`,
    );
  }
  return result("unknown", `couldn't check: the ${vendor} API answered HTTP ${status}`);
}

/** A failed check as one line for a person: provider, tiers, model, where, why and the fix. */
export function describeModelProblem(result: ModelCheckResult): string {
  const tiers = result.tiers.join(", ");
  const fix = result.fix === undefined ? "" : ` Fix: ${result.fix}.`;
  return `${result.providerId} (${tiers}): ${result.model}: ${result.problem ?? result.status}.${fix}`;
}

/** AWS errors that say a model or profile ID doesn't exist (or isn't a valid one) here. */
const NOT_FOUND_ERRORS = new Set(["ResourceNotFoundException", "ValidationException"]);

/** The parts of `@aws-sdk/client-bedrock` the checks use, passed in so this package needs no SDK. */
export interface BedrockSdk {
  client: { send(command: unknown): Promise<unknown> };
  GetInferenceProfileCommand: new (input: { inferenceProfileIdentifier: string }) => unknown;
  GetFoundationModelCommand: new (input: { modelIdentifier: string }) => unknown;
  GetFoundationModelAvailabilityCommand: new (input: { modelId: string }) => unknown;
}

/** A `BedrockModelApi` on the AWS SDK's Bedrock client. */
export function bedrockModelApi(sdk: BedrockSdk): BedrockModelApi {
  const send = async <T>(command: unknown): Promise<T> => {
    try {
      return (await sdk.client.send(command)) as T;
    } catch (error) {
      if (error instanceof Error && NOT_FOUND_ERRORS.has(error.name)) {
        throw new BedrockNotFound(error.message);
      }
      throw error;
    }
  };
  return {
    async inferenceProfile(id) {
      const reply = await send<{
        status?: string;
        models?: { modelArn?: string }[];
      }>(new sdk.GetInferenceProfileCommand({ inferenceProfileIdentifier: id }));
      return {
        status: reply.status,
        modelIds: (reply.models ?? []).flatMap((model) => {
          const id = /foundation-model\/(.+)$/.exec(model.modelArn ?? "")?.[1];
          return id === undefined ? [] : [id];
        }),
      };
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
        agreementAvailability?: { status?: string };
      }>(new sdk.GetFoundationModelAvailabilityCommand({ modelId: id }));
      return {
        region: reply.regionAvailability,
        entitlement: reply.entitlementAvailability,
        agreement: reply.agreementAvailability?.status,
      };
    },
  };
}

/** A `StatusGet` on `fetch`, which reads no body and gives up after 10 s. */
export const fetchStatus: StatusGet = async (url, headers) => {
  const reply = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  await reply.body?.cancel();
  return reply.status;
};
