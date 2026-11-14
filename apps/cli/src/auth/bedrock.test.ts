import {
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { describe, expect, it } from "vitest";
import { awsBedrockAccess, type BedrockSender } from "./bedrock.js";

const AVAILABLE = {
  regionAvailability: "AVAILABLE",
  authorizationStatus: "AUTHORIZED",
  entitlementAvailability: "AVAILABLE",
  agreementAvailability: { status: "AVAILABLE" },
};

describe("awsBedrockAccess", () => {
  it("checks every active Anthropic text model and says what blocks each", async () => {
    const sent: unknown[] = [];
    const client: BedrockSender = {
      send: (command) => {
        sent.push(command);
        if (command instanceof ListFoundationModelsCommand) {
          return Promise.resolve({
            modelSummaries: [
              { modelId: "anthropic.ok", modelName: "OK", modelLifecycle: { status: "ACTIVE" } },
              { modelId: "anthropic.old", modelLifecycle: { status: "LEGACY" } },
              { modelId: "anthropic.blocked" },
            ],
          });
        }
        return Promise.resolve(
          command.input.modelId === "anthropic.ok"
            ? AVAILABLE
            : {
                regionAvailability: "AVAILABLE",
                authorizationStatus: "NOT_AUTHORIZED",
                entitlementAvailability: "NOT_AVAILABLE",
                agreementAvailability: { status: "NOT_AVAILABLE" },
              },
        );
      },
    };
    const models = await awsBedrockAccess(client, "us-east-1").anthropicModels();
    expect(models).toEqual([
      { modelId: "anthropic.ok", name: "OK", usable: true, problems: [] },
      {
        modelId: "anthropic.blocked",
        name: "anthropic.blocked",
        usable: false,
        problems: ["IAM doesn't allow it", "model access not granted", "agreement not available"],
      },
    ]);
    expect((sent[0] as ListFoundationModelsCommand).input).toEqual({
      byProvider: "Anthropic",
      byOutputModality: "TEXT",
    });
    expect(sent.filter((c) => c instanceof GetFoundationModelAvailabilityCommand)).toHaveLength(2);
  });

  it("wraps AWS errors with the region", async () => {
    const client: BedrockSender = {
      send: () => Promise.reject(Object.assign(new Error("denied"), { name: "AccessDenied" })),
    };
    await expect(awsBedrockAccess(client, "us-east-1").anthropicModels()).rejects.toThrow(
      "AWS Bedrock (us-east-1) failed on ListFoundationModels: denied.",
    );
  });
});
