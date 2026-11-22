import { parseDeployConfig } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { bedrockStatements, modelCheckStatements } from "./bedrock.js";

const provider = (models?: Record<string, string>) =>
  parseDeployConfig({
    allowedOrgs: ["acme"],
    providers: [
      { id: "bedrock", harness: "claude-code", auth: "bedrock", ...(models ? { models } : {}) },
    ],
  }).providers[0]!;

const json = (models?: Record<string, string>) =>
  bedrockStatements(provider(models), "aws", "123456789012").map((s) => s.toStatementJson());

describe("bedrockStatements", () => {
  it("allows every Anthropic model and profile when a tier uses an alias", () => {
    const [invoke, list, get] = json();
    expect(invoke).toMatchObject({
      Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      Resource: [
        "arn:aws:bedrock:*::foundation-model/anthropic.*",
        "arn:aws:bedrock:*:123456789012:inference-profile/*anthropic.*",
      ],
    });
    expect(list).toMatchObject({ Action: "bedrock:ListInferenceProfiles", Resource: "*" });
    expect(get).toMatchObject({ Action: "bedrock:GetInferenceProfile" });
    // Never any model, Anthropic's or not.
    expect(JSON.stringify(invoke)).not.toContain("foundation-model/*");
  });

  it("allows exactly the pinned models and their profiles", () => {
    const [invoke] = json({
      fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      standard: "us.anthropic.claude-sonnet-4-6",
      deep: "anthropic.claude-opus-4-8",
    });
    expect(invoke?.Resource).toEqual([
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-8",
      "arn:aws:bedrock:*:123456789012:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:*:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6",
    ]);
  });

  it("drops a [1m]-style modifier, which isn't part of the model ID", () => {
    const [invoke] = json({
      fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      standard: "us.anthropic.claude-sonnet-4-6[1m]",
      deep: "anthropic.claude-opus-4-8",
    });
    expect(invoke?.Resource).toContain(
      "arn:aws:bedrock:*:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6",
    );
    expect(invoke?.Resource).toContain(
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6",
    );
    expect(JSON.stringify(invoke)).not.toContain("[1m]");
  });

  it("allows a tier pinned to an application inference profile ARN as given", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";
    const [invoke, , get] = json({ standard: arn });
    expect(invoke?.Resource).toContain(arn);
    expect(invoke?.Resource).toContain("arn:aws:bedrock:*::foundation-model/anthropic.*");
    expect(get?.Resource).toContain(arn);
    const [withModifier] = json({ standard: `${arn}[1m]` });
    expect(withModifier?.Resource).toContain(arn);
    expect(JSON.stringify(withModifier)).not.toContain("[1m]");
  });

  it("falls back to Anthropic's models when one tier is still an alias", () => {
    const [invoke] = json({ fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    expect(invoke?.Resource).toContain("arn:aws:bedrock:*::foundation-model/anthropic.*");
  });
});

describe("modelCheckStatements", () => {
  const check = (model: string) => ({
    providerId: "bedrock",
    kind: "bedrock" as const,
    model,
    tiers: ["standard" as const],
  });
  const statementsFor = (models: string[]) =>
    modelCheckStatements(models.map(check), "aws", "us-east-2", "123456789012").map((s) =>
      s.toStatementJson(),
    );

  it("describes each profile and bare model in the stack's region, and invokes nothing", () => {
    expect(
      statementsFor([
        "us.anthropic.claude-sonnet-4-6",
        "anthropic.claude-haiku-4-5-20251001-v1:0",
        "anthropic.claude-sonnet-4-6-v1:0:200k",
      ]),
    ).toEqual([
      {
        Effect: "Allow",
        Action: "bedrock:GetInferenceProfile",
        Resource:
          "arn:aws:bedrock:us-east-2:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6",
      },
      {
        Effect: "Allow",
        Action: "bedrock:GetFoundationModel",
        // The variant as configured: it's what Claude Code calls, so it's what's described.
        Resource: [
          "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
          "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-6-v1:0:200k",
        ],
      },
      { Effect: "Allow", Action: "bedrock:GetFoundationModelAvailability", Resource: "*" },
    ]);
  });

  it("grants nothing when there is no Bedrock model to check", () => {
    expect(statementsFor([])).toEqual([]);
    expect(
      modelCheckStatements(
        [{ ...check("claude-sonnet-4-6"), kind: "anthropic-api" }],
        "aws",
        "us-east-2",
        "123456789012",
      ),
    ).toEqual([]);
  });
});
