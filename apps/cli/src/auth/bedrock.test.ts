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
  it("checks each current base model, and says what blocks each", async () => {
    const sent: unknown[] = [];
    const client: BedrockSender = {
      send: (command) => {
        sent.push(command);
        if (command instanceof ListFoundationModelsCommand) {
          return Promise.resolve({
            modelSummaries: [
              {
                modelId: "anthropic.ok",
                modelName: "OK",
                modelLifecycle: { status: "ACTIVE" },
                inferenceTypesSupported: ["INFERENCE_PROFILE"],
              },
              { modelId: "anthropic.old", modelLifecycle: { status: "LEGACY" } },
              { modelId: "anthropic.blocked", inferenceTypesSupported: ["ON_DEMAND"] },
              // A context-window variant and a provisioned-only model aren't checked.
              { modelId: "anthropic.ok:0:200k", inferenceTypesSupported: ["ON_DEMAND"] },
              { modelId: "anthropic.provisioned", inferenceTypesSupported: ["PROVISIONED"] },
            ],
          });
        }
        return Promise.resolve(
          command.input.modelId === "anthropic.ok"
            ? { ...AVAILABLE, authorizationStatus: "NOT_AUTHORIZED" }
            : {
                regionAvailability: "AVAILABLE",
                authorizationStatus: "AUTHORIZED",
                entitlementAvailability: "NOT_AVAILABLE",
                agreementAvailability: { status: "NOT_AVAILABLE" },
              },
        );
      },
    };
    const models = await awsBedrockAccess(client, "us-east-1").anthropicModels();
    expect(models).toEqual([
      // The caller's own IAM permission is reported, but doesn't make the model unusable.
      {
        modelId: "anthropic.ok",
        name: "OK",
        usable: true,
        problems: [],
        inferenceTypes: ["INFERENCE_PROFILE"],
        legacy: false,
        callerAuthorized: false,
      },
      // Legacy models are kept, marked, so a tier that pins one can still be checked.
      {
        modelId: "anthropic.old",
        name: "anthropic.old",
        usable: false,
        problems: ["model access not granted", "agreement not available"],
        inferenceTypes: [],
        legacy: true,
        callerAuthorized: true,
      },
      {
        modelId: "anthropic.blocked",
        name: "anthropic.blocked",
        usable: false,
        problems: ["model access not granted", "agreement not available"],
        inferenceTypes: ["ON_DEMAND"],
        legacy: false,
        callerAuthorized: true,
      },
    ]);
    expect((sent[0] as ListFoundationModelsCommand).input).toEqual({
      byProvider: "Anthropic",
      byOutputModality: "TEXT",
    });
    expect(sent.filter((c) => c instanceof GetFoundationModelAvailabilityCommand)).toHaveLength(3);
  });

  it("treats one model Bedrock won't describe as that model's problem", async () => {
    const client: BedrockSender = {
      send: (command) => {
        if (command instanceof ListFoundationModelsCommand) {
          return Promise.resolve({
            modelSummaries: [{ modelId: "anthropic.weird" }, { modelId: "anthropic.ok" }],
          });
        }
        return command.input.modelId === "anthropic.weird"
          ? Promise.reject(
              Object.assign(new Error("bad model id."), { name: "ValidationException" }),
            )
          : Promise.resolve(AVAILABLE);
      },
    };
    const models = await awsBedrockAccess(client, "us-east-1").anthropicModels();
    expect(models).toEqual([
      {
        modelId: "anthropic.weird",
        name: "anthropic.weird",
        usable: false,
        problems: ["couldn't check (bad model id)"],
        inferenceTypes: [],
        legacy: false,
      },
      {
        modelId: "anthropic.ok",
        name: "anthropic.ok",
        usable: true,
        problems: [],
        inferenceTypes: [],
        legacy: false,
        callerAuthorized: true,
      },
    ]);
  });

  it("fails the whole check on an account-wide error, with the sign-in hint", async () => {
    for (const name of ["AccessDeniedException", "ThrottlingException", "ExpiredTokenException"]) {
      const client: BedrockSender = {
        send: (command) =>
          command instanceof ListFoundationModelsCommand
            ? Promise.resolve({ modelSummaries: [{ modelId: "anthropic.ok" }] })
            : Promise.reject(Object.assign(new Error("nope"), { name })),
      };
      await expect(awsBedrockAccess(client, "us-east-1").anthropicModels()).rejects.toThrow(
        "AWS Bedrock (us-east-1) failed on GetFoundationModelAvailability anthropic.ok: nope.",
      );
    }
    const expired: BedrockSender = {
      send: (command) =>
        command instanceof ListFoundationModelsCommand
          ? Promise.resolve({ modelSummaries: [{ modelId: "anthropic.ok" }] })
          : Promise.reject(Object.assign(new Error("expired"), { name: "ExpiredTokenException" })),
    };
    await expect(awsBedrockAccess(expired, "us-east-1").anthropicModels()).rejects.toThrow(
      "aws sso login",
    );
  });

  it("wraps a failed listing with the region", async () => {
    const client: BedrockSender = {
      send: () => Promise.reject(Object.assign(new Error("denied"), { name: "AccessDenied" })),
    };
    await expect(awsBedrockAccess(client, "us-east-1").anthropicModels()).rejects.toThrow(
      "AWS Bedrock (us-east-1) failed on ListFoundationModels: denied.",
    );
  });
});
