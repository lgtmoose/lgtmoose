import {
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
  type ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { describe, expect, it } from "vitest";
import { awsBedrockAccess, bedrockDetail, type BedrockSender } from "./bedrock.js";

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
          (command.input as { modelId?: string }).modelId === "anthropic.ok"
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
      {
        modelId: "anthropic.blocked",
        name: "anthropic.blocked",
        usable: false,
        problems: [
          { text: "model access not granted", fix: "access" },
          { text: "agreement not available", fix: "access" },
        ],
        inferenceTypes: ["ON_DEMAND"],
        legacy: false,
        callerAuthorized: true,
      },
    ]);
    expect((sent[0] as ListFoundationModelsCommand).input).toEqual({
      byProvider: "Anthropic",
      byOutputModality: "TEXT",
    });
    expect(sent.filter((c) => c instanceof GetFoundationModelAvailabilityCommand)).toHaveLength(2);
    // A legacy model is checked only when asked for: a tier pins it.
    const withLegacy = await awsBedrockAccess(client, "us-east-1").anthropicModels({
      legacyToCheck: new Set(["anthropic.old"]),
    });
    expect(withLegacy.find((m) => m.modelId === "anthropic.old")).toMatchObject({
      legacy: true,
      usable: false,
    });
  });

  it("reports only the region when a model isn't offered here, and waits on a pending agreement", async () => {
    const client: BedrockSender = {
      send: (command) => {
        if (command instanceof ListFoundationModelsCommand) {
          return Promise.resolve({
            modelSummaries: [
              { modelId: "anthropic.away" },
              { modelId: "anthropic.pending" },
              { modelId: "anthropic.both" },
            ],
          });
        }
        const id = (command.input as { modelId?: string }).modelId;
        if (id === "anthropic.away") {
          return Promise.resolve({
            regionAvailability: "NOT_AVAILABLE",
            entitlementAvailability: "NOT_AVAILABLE",
            agreementAvailability: { status: "NOT_AVAILABLE" },
          });
        }
        return Promise.resolve({
          ...AVAILABLE,
          // "both": access isn't granted, and the agreement is still pending.
          entitlementAvailability: id === "anthropic.both" ? "NOT_AVAILABLE" : "AVAILABLE",
          agreementAvailability: { status: "PENDING" },
        });
      },
    };
    const [away, pending, both] = await awsBedrockAccess(client, "eu-west-2").anthropicModels();
    expect(away?.problems).toEqual([{ text: "not offered in this region", fix: "region" }]);
    // Access granted, agreement on its way: only the wait.
    expect(pending?.problems).toEqual([{ text: "agreement pending", fix: "wait" }]);
    // A pending agreement doesn't hide missing access: both, as Bedrock reports them.
    expect(both?.problems).toEqual([
      { text: "model access not granted", fix: "access" },
      { text: "agreement pending", fix: "wait" },
    ]);
  });

  it("adds Bedrock's own reason to an agreement in error, cleaned and cut short", async () => {
    const client: BedrockSender = {
      send: (command) =>
        command instanceof ListFoundationModelsCommand
          ? Promise.resolve({ modelSummaries: [{ modelId: "anthropic.err" }] })
          : Promise.resolve({
              ...AVAILABLE,
              agreementAvailability: {
                status: "ERROR",
                errorMessage: "Offer\n\u001b[31mexpired\t ",
              },
            }),
    };
    const [model] = await awsBedrockAccess(client, "eu-west-2").anthropicModels();
    expect(model?.problems).toEqual([
      { text: "agreement error (Offer [31mexpired)", fix: "access" },
    ]);
    expect(bedrockDetail(undefined)).toBe("");
    expect(bedrockDetail(" \n ")).toBe("");
    const long = bedrockDetail("x".repeat(500));
    expect(long).toHaveLength(" ()".length + 200);
    expect(long.endsWith("…)")).toBe(true);
  });

  it("treats one model Bedrock won't describe as that model's problem", async () => {
    const client: BedrockSender = {
      send: (command) => {
        if (command instanceof ListFoundationModelsCommand) {
          return Promise.resolve({
            modelSummaries: [{ modelId: "anthropic.weird" }, { modelId: "anthropic.ok" }],
          });
        }
        return (command.input as { modelId?: string }).modelId === "anthropic.weird"
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
        problems: [{ text: "couldn't check (bad model id)", fix: "recheck" }],
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

  it("lists the active system-defined Anthropic inference profiles across pages", async () => {
    const sent: ListInferenceProfilesCommand[] = [];
    const arn = (id: string, region = "us-east-1") =>
      `arn:aws:bedrock:${region}::foundation-model/${id}`;
    const pages = [
      {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "eu.anthropic.a",
            status: "ACTIVE",
            models: [
              { modelArn: arn("anthropic.a", "eu-west-1") },
              { modelArn: arn("anthropic.a") },
            ],
          },
          {
            inferenceProfileId: "eu.meta.x",
            status: "ACTIVE",
            models: [{ modelArn: arn("meta.x") }],
          },
        ],
        nextToken: "p2",
      },
      {
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "global.anthropic.b",
            status: "ACTIVE",
            models: [{ modelArn: arn("anthropic.b") }],
          },
          {
            inferenceProfileId: "eu.anthropic.c",
            status: "INACTIVE",
            models: [{ modelArn: arn("anthropic.c") }],
          },
        ],
      },
    ];
    const client: BedrockSender = {
      send: (command) => {
        sent.push(command as ListInferenceProfilesCommand);
        return Promise.resolve(pages.shift() ?? {});
      },
    };
    expect(await awsBedrockAccess(client, "eu-west-2").inferenceProfiles()).toEqual([
      { id: "eu.anthropic.a", modelId: "anthropic.a" },
      { id: "global.anthropic.b", modelId: "anthropic.b" },
    ]);
    expect(sent.map((c) => c.input)).toEqual([
      { typeEquals: "SYSTEM_DEFINED", nextToken: undefined },
      { typeEquals: "SYSTEM_DEFINED", nextToken: "p2" },
    ]);
  });

  it("treats a denied profile listing as unknown, and fails on any other error", async () => {
    const failing = (name: string): BedrockSender => ({
      send: () => Promise.reject(Object.assign(new Error("nope"), { name })),
    });
    await expect(
      awsBedrockAccess(failing("AccessDeniedException"), "eu-west-2").inferenceProfiles(),
    ).resolves.toBeUndefined();
    await expect(
      awsBedrockAccess(failing("ThrottlingException"), "eu-west-2").inferenceProfiles(),
    ).rejects.toThrow("failed on ListInferenceProfiles: nope.");
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
