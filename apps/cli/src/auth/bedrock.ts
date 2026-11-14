import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { awsError, awsReason, errorName } from "../aws-errors.js";

/** Whether this account can call one Bedrock model in the region. */
export interface ModelAccess {
  modelId: string;
  name: string;
  /**
   * True when the account-level checks pass: offered in the region, model access granted and
   * the agreement accepted. These apply to every identity in the account, the sandbox's
   * task role included.
   */
  usable: boolean;
  /** Why it isn't usable, as Bedrock says it. Empty when usable. */
  problems: BedrockProblem[];
  /**
   * How it can be called: `ON_DEMAND` by its own id, `INFERENCE_PROFILE` through a
   * cross-region profile id such as `us.<id>`. Empty when Bedrock doesn't say.
   */
  inferenceTypes: string[];
  /** Bedrock marks it LEGACY: still callable for now, but on its way out. */
  legacy: boolean;
  /**
   * Whether the identity running this CLI may call the model. It says nothing about the
   * sandbox task role, which deploy grants its own Bedrock access, so it never makes a model
   * unusable. Undefined when the check couldn't run.
   */
  callerAuthorized?: boolean;
}

/**
 * One reason a model can't be used, with the one thing that fixes it: `access` (model access
 * or its agreement, in the Bedrock console), `region` (Bedrock doesn't offer it here) or
 * `recheck` (Bedrock couldn't describe it).
 */
export interface BedrockProblem {
  text: string;
  fix: "access" | "region" | "recheck";
}

/** The Bedrock calls `auth bedrock` makes. Tests swap in a fake. */
export interface BedrockAccess {
  /**
   * Anthropic's current base text models in the region, and whether this account may use
   * each. Legacy models are left out, except those in `legacyToCheck` (ones a tier pins).
   */
  anthropicModels(options?: { legacyToCheck?: ReadonlySet<string> }): Promise<ModelAccess[]>;
  /**
   * The system-defined inference profiles this region can call, for Anthropic models.
   * Undefined when this identity may not list them (no bedrock:ListInferenceProfiles).
   */
  inferenceProfiles(): Promise<InferenceProfile[] | undefined>;
}

/** A cross-region inference profile, such as `us.anthropic.…`, and the model it runs. */
export interface InferenceProfile {
  /** The id to call it by, and to pin in `models`. */
  id: string;
  /** The foundation model it runs, such as `anthropic.…`. */
  modelId: string;
}

type Command =
  | ListFoundationModelsCommand
  | GetFoundationModelAvailabilityCommand
  | ListInferenceProfilesCommand;

/** The subset of BedrockClient we use, so tests can fake `send`. */
export interface BedrockSender {
  send(command: Command): Promise<{
    modelSummaries?:
      | {
          modelId?: string | undefined;
          modelName?: string | undefined;
          modelLifecycle?: { status?: string | undefined } | undefined;
          inferenceTypesSupported?: string[] | undefined;
        }[]
      | undefined;
    agreementAvailability?:
      { status?: string | undefined; errorMessage?: string | undefined } | undefined;
    authorizationStatus?: string | undefined;
    entitlementAvailability?: string | undefined;
    regionAvailability?: string | undefined;
    inferenceProfileSummaries?:
      | {
          inferenceProfileId?: string | undefined;
          status?: string | undefined;
          models?: { modelArn?: string | undefined }[] | undefined;
        }[]
      | undefined;
    nextToken?: string | undefined;
  }>;
}

/** Context-window variants such as `…-v1:0:200k` share their base model's access. */
export const CONTEXT_VARIANT = /:\d+k$/;

/** Ways a model is called without buying provisioned throughput. */
const CALLABLE = new Set(["ON_DEMAND", "INFERENCE_PROFILE"]);

/**
 * Errors about one model id, which make only that model unusable. Anything else (access
 * denied, throttling, expired credentials) is about the whole account and fails the check.
 */
const PER_MODEL_ERRORS = new Set(["ValidationException", "ResourceNotFoundException"]);

export function awsBedrockAccess(client: BedrockSender, region: string): BedrockAccess {
  return {
    async anthropicModels(options = {}) {
      let summaries;
      try {
        ({ modelSummaries: summaries } = await client.send(
          new ListFoundationModelsCommand({ byProvider: "Anthropic", byOutputModality: "TEXT" }),
        ));
      } catch (error) {
        throw awsError("Bedrock", region, "ListFoundationModels", error);
      }
      const base = (summaries ?? []).filter(
        (model): model is typeof model & { modelId: string } =>
          model.modelId !== undefined &&
          !CONTEXT_VARIANT.test(model.modelId) &&
          (model.modelLifecycle?.status !== "LEGACY" ||
            (options.legacyToCheck?.has(model.modelId) ?? false)) &&
          // Bedrock leaves this out for some models; only drop the ones it says are provisioned-only.
          (model.inferenceTypesSupported === undefined ||
            model.inferenceTypesSupported.some((type) => CALLABLE.has(type))),
      );
      // One at a time: Bedrock's control plane throttles bursts, and there are only a few dozen.
      const results: ModelAccess[] = [];
      for (const model of base) {
        const entry = {
          modelId: model.modelId,
          name: model.modelName ?? model.modelId,
          inferenceTypes: model.inferenceTypesSupported ?? [],
          legacy: model.modelLifecycle?.status === "LEGACY",
        };
        let availability;
        try {
          availability = await client.send(
            new GetFoundationModelAvailabilityCommand({ modelId: model.modelId }),
          );
        } catch (error) {
          if (!PER_MODEL_ERRORS.has(errorName(error) ?? "")) {
            throw awsError(
              "Bedrock",
              region,
              `GetFoundationModelAvailability ${model.modelId}`,
              error,
            );
          }
          const reason = awsReason(error);
          results.push({
            ...entry,
            usable: false,
            problems: [{ text: `couldn't check (${reason})`, fix: "recheck" }],
          });
          continue;
        }
        const problems: BedrockProblem[] = [];
        if (availability.regionAvailability !== "AVAILABLE") {
          problems.push({ text: "not offered in this region", fix: "region" });
        }
        if (availability.entitlementAvailability !== "AVAILABLE") {
          problems.push({ text: "model access not granted", fix: "access" });
        }
        const agreement = availability.agreementAvailability?.status ?? "UNKNOWN";
        if (agreement !== "AVAILABLE") {
          problems.push({
            text: `agreement ${agreement.toLowerCase().replaceAll("_", " ")}`,
            fix: "access",
          });
        }
        results.push({
          ...entry,
          usable: problems.length === 0,
          problems,
          callerAuthorized: availability.authorizationStatus === "AUTHORIZED",
        });
      }
      return results;
    },

    async inferenceProfiles() {
      const profiles: InferenceProfile[] = [];
      let nextToken: string | undefined;
      do {
        let page;
        try {
          page = await client.send(
            new ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", nextToken }),
          );
        } catch (error) {
          // Only this permission is missing: the rest of the check can still run.
          if (errorName(error) === "AccessDeniedException") return undefined;
          throw awsError("Bedrock", region, "ListInferenceProfiles", error);
        }
        for (const profile of page.inferenceProfileSummaries ?? []) {
          const id = profile.inferenceProfileId;
          if (id === undefined || profile.status !== "ACTIVE") continue;
          // Every region the profile routes to lists the same model; take it from the ARN.
          const modelId = profile.models
            ?.map((model) => /foundation-model\/(.+)$/.exec(model.modelArn ?? "")?.[1])
            .find((found) => found !== undefined);
          if (modelId?.startsWith("anthropic.")) profiles.push({ id, modelId });
        }
        nextToken = page.nextToken;
      } while (nextToken !== undefined);
      return profiles;
    },
  };
}

export function createBedrockAccess(region: string): BedrockAccess {
  return awsBedrockAccess(new BedrockClient({ region }), region);
}
