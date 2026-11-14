import { parseDeployConfig } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { bedrockStatements } from "./bedrock.js";

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

  it("falls back to Anthropic's models when one tier is still an alias", () => {
    const [invoke] = json({ fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0" });
    expect(invoke?.Resource).toContain("arn:aws:bedrock:*::foundation-model/anthropic.*");
  });
});
