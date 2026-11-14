import { describe, expect, it } from "vitest";
import { parseDeployConfig } from "./deploy.js";
import { isModelAlias, providerModelEnv, vertexHost } from "./models.js";

const provider = (fields: Record<string, unknown>) =>
  parseDeployConfig({ allowedOrgs: ["acme"], providers: [{ id: "p", ...fields }] }).providers[0]!;

describe("isModelAlias", () => {
  it("knows Claude Code's aliases and their modifiers", () => {
    for (const alias of ["sonnet", "opus", "haiku", "opusplan", "default", "sonnet[1m]"]) {
      expect(isModelAlias(alias)).toBe(true);
    }
    for (const id of ["us.anthropic.claude-sonnet-4-6", "claude-opus-4-8", "global.anthropic.x"]) {
      expect(isModelAlias(id)).toBe(false);
    }
  });
});

describe("providerModelEnv", () => {
  it("steers the alias variables with pinned Bedrock models only", () => {
    const env = providerModelEnv(
      provider({
        harness: "claude-code",
        auth: "bedrock",
        models: {
          fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          standard: "sonnet",
          deep: "us.anthropic.claude-opus-4-8",
        },
      }),
    );
    expect(env).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-4-8",
    });
  });

  it("sets Vertex's region and project", () => {
    expect(providerModelEnv(provider({ harness: "agent-sdk", auth: "vertex" }))).toEqual({
      CLOUD_ML_REGION: "global",
    });
    expect(
      providerModelEnv(
        provider({
          harness: "claude-code",
          auth: "vertex",
          vertex: { region: "us-east5", projectId: "acme-reviews" },
        }),
      ),
    ).toEqual({ CLOUD_ML_REGION: "us-east5", ANTHROPIC_VERTEX_PROJECT_ID: "acme-reviews" });
  });

  it("is empty for providers that take models another way", () => {
    expect(
      providerModelEnv(
        provider({ harness: "claude-code", auth: "api-key", models: { fast: "x-y" } }),
      ),
    ).toEqual({});
    expect(providerModelEnv(provider({ harness: "codex", auth: "api-key" }))).toEqual({});
  });

  it("refuses vertex settings on another auth method", () => {
    expect(() =>
      provider({ harness: "claude-code", auth: "bedrock", vertex: { region: "global" } }),
    ).toThrow(/vertex settings apply only/);
  });
});

describe("vertexHost", () => {
  it("picks the global, multi-region or regional endpoint", () => {
    expect(vertexHost("global")).toBe("aiplatform.googleapis.com");
    expect(vertexHost("us")).toBe("aiplatform.us.rep.googleapis.com");
    expect(vertexHost("europe-west1")).toBe("europe-west1-aiplatform.googleapis.com");
  });
});
