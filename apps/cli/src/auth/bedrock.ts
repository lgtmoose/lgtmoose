import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { awsError } from "../aws-errors.js";

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
  /** Why it isn't usable. Empty when usable. */
  problems: string[];
  /**
   * Whether the identity running this CLI may call the model. It says nothing about the
   * sandbox task role, which deploy grants its own Bedrock access, so it never makes a model
   * unusable. Undefined when the check couldn't run.
   */
  callerAuthorized?: boolean;
}

/** The Bedrock calls `auth bedrock` makes. Tests swap in a fake. */
export interface BedrockAccess {
  /** Anthropic's current base text models in the region, and whether this account may use each. */
  anthropicModels(): Promise<ModelAccess[]>;
}

type Command = ListFoundationModelsCommand | GetFoundationModelAvailabilityCommand;

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
  }>;
}

/** Context-window variants such as `…-v1:0:200k` share their base model's access. */
export const CONTEXT_VARIANT = /:\d+k$/;

/**
 * Ways a model is called without buying provisioned throughput. Newer Claude models are only
 * offered through inference profiles, so ON_DEMAND alone would miss them.
 */
const CALLABLE = new Set(["ON_DEMAND", "INFERENCE_PROFILE"]);

export function awsBedrockAccess(client: BedrockSender, region: string): BedrockAccess {
  return {
    async anthropicModels() {
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
          model.modelLifecycle?.status !== "LEGACY" &&
          // Bedrock leaves this out for some models; only drop the ones it says are provisioned-only.
          (model.inferenceTypesSupported === undefined ||
            model.inferenceTypesSupported.some((type) => CALLABLE.has(type))),
      );
      // One at a time: Bedrock's control plane throttles bursts, and there are only a few dozen.
      const results: ModelAccess[] = [];
      for (const model of base) {
        const name = model.modelName ?? model.modelId;
        let availability;
        try {
          availability = await client.send(
            new GetFoundationModelAvailabilityCommand({ modelId: model.modelId }),
          );
        } catch (error) {
          // One model Bedrock won't describe is that model's problem, not the whole check's.
          const reason = error instanceof Error ? error.message : String(error);
          results.push({
            modelId: model.modelId,
            name,
            usable: false,
            problems: [`couldn't check (${reason.replace(/\.$/, "")})`],
          });
          continue;
        }
        const problems: string[] = [];
        if (availability.regionAvailability !== "AVAILABLE") {
          problems.push("not offered in this region");
        }
        if (availability.entitlementAvailability !== "AVAILABLE") {
          problems.push("model access not granted");
        }
        const agreement = availability.agreementAvailability?.status ?? "UNKNOWN";
        if (agreement !== "AVAILABLE") {
          problems.push(`agreement ${agreement.toLowerCase().replaceAll("_", " ")}`);
        }
        results.push({
          modelId: model.modelId,
          name,
          usable: problems.length === 0,
          problems,
          callerAuthorized: availability.authorizationStatus === "AUTHORIZED",
        });
      }
      return results;
    },
  };
}

export function createBedrockAccess(region: string): BedrockAccess {
  return awsBedrockAccess(new BedrockClient({ region }), region);
}
