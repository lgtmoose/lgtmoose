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
  /** True when every check Bedrock reports passes. */
  usable: boolean;
  /** Why it isn't usable, in Bedrock's terms. Empty when usable. */
  problems: string[];
}

/** The Bedrock calls `auth bedrock` makes. Tests swap in a fake. */
export interface BedrockAccess {
  /** Anthropic's active text models in the region, and whether this account may call each. */
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
        }[]
      | undefined;
    agreementAvailability?:
      { status?: string | undefined; errorMessage?: string | undefined } | undefined;
    authorizationStatus?: string | undefined;
    entitlementAvailability?: string | undefined;
    regionAvailability?: string | undefined;
  }>;
}

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
      const active = (summaries ?? []).filter(
        (model): model is typeof model & { modelId: string } =>
          model.modelId !== undefined && model.modelLifecycle?.status !== "LEGACY",
      );
      return Promise.all(
        active.map(async (model): Promise<ModelAccess> => {
          let availability;
          try {
            availability = await client.send(
              new GetFoundationModelAvailabilityCommand({ modelId: model.modelId }),
            );
          } catch (error) {
            throw awsError("Bedrock", region, model.modelId, error);
          }
          const problems: string[] = [];
          if (availability.regionAvailability !== "AVAILABLE") {
            problems.push("not offered in this region");
          }
          if (availability.authorizationStatus !== "AUTHORIZED") {
            problems.push("IAM doesn't allow it");
          }
          if (availability.entitlementAvailability !== "AVAILABLE") {
            problems.push("model access not granted");
          }
          const agreement = availability.agreementAvailability?.status;
          if (agreement !== "AVAILABLE") {
            problems.push(
              agreement === "PENDING"
                ? "agreement pending"
                : `agreement ${agreement?.toLowerCase().replace("_", " ") ?? "unknown"}`,
            );
          }
          return {
            modelId: model.modelId,
            name: model.modelName ?? model.modelId,
            usable: problems.length === 0,
            problems,
          };
        }),
      );
    },
  };
}

export function createBedrockAccess(region: string): BedrockAccess {
  return awsBedrockAccess(new BedrockClient({ region }), region);
}
