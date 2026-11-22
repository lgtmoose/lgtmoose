import { describe, expect, it } from "vitest";
import { parseDeployConfig } from "./deploy.js";
import {
  BedrockNotFound,
  checkApiModel,
  checkBedrockModel,
  describeModelProblem,
  planModelChecks,
  type BedrockModelApi,
  type ModelToCheck,
} from "./model-checks.js";

const config = (providers: Record<string, unknown>[]) =>
  parseDeployConfig({ allowedOrgs: ["acme"], providers });

describe("planModelChecks", () => {
  it("checks pinned models once per model, and skips aliases, ARNs and plan sign-ins", () => {
    const { checks, skipped } = planModelChecks(
      config([
        {
          id: "bedrock",
          harness: "claude-code",
          auth: "bedrock",
          models: {
            fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
            standard: "us.anthropic.claude-sonnet-4-6[1m]",
            deep: "us.anthropic.claude-sonnet-4-6",
          },
        },
        {
          id: "anthropic",
          harness: "agent-sdk",
          auth: "api-key",
          models: { standard: "claude-sonnet-4-6" },
        },
        { id: "openai", harness: "codex", auth: "api-key", models: { standard: "gpt-5-codex" } },
        { id: "plan", harness: "claude-code", auth: "oauth-token" },
      ]),
    );
    expect(checks).toEqual([
      {
        providerId: "bedrock",
        kind: "bedrock",
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        tiers: ["fast"],
      },
      {
        providerId: "bedrock",
        kind: "bedrock",
        model: "us.anthropic.claude-sonnet-4-6",
        tiers: ["standard", "deep"],
      },
      {
        providerId: "anthropic",
        kind: "anthropic-api",
        model: "claude-sonnet-4-6",
        tiers: ["standard"],
      },
      { providerId: "openai", kind: "openai-api", model: "gpt-5-codex", tiers: ["standard"] },
    ]);
    expect(skipped.map((skip) => [skip.providerId, skip.tiers, skip.model])).toEqual([
      ["anthropic", ["fast"], "haiku"],
      ["anthropic", ["deep"], "opus"],
      ["openai", ["fast", "deep"], undefined],
      ["plan", ["fast"], "haiku"],
      ["plan", ["standard"], "sonnet"],
      ["plan", ["deep"], "opus"],
    ]);
    expect(skipped.find((skip) => skip.providerId === "plan")?.reason).toMatch(/subscription/);
  });

  it("skips an ARN, used as given", () => {
    const arn = "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/abc";
    const { checks, skipped } = planModelChecks(
      config([
        {
          id: "bedrock",
          harness: "claude-code",
          auth: "bedrock",
          models: { fast: arn, standard: arn, deep: arn },
        },
      ]),
    );
    expect(checks).toEqual([]);
    expect(skipped).toEqual([
      expect.objectContaining({ model: arn, tiers: ["fast", "standard", "deep"] }),
    ]);
  });
});

const bedrockCheck = (model: string): ModelToCheck => ({
  providerId: "bedrock",
  kind: "bedrock",
  model,
  tiers: ["standard"],
});

function fakeBedrock(overrides: Partial<BedrockModelApi> = {}): BedrockModelApi & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    inferenceProfile: async (id) => {
      calls.push(`profile ${id}`);
      return { status: "ACTIVE", modelIds: [] };
    },
    foundationModel: async (id) => {
      calls.push(`model ${id}`);
      return { inferenceTypes: ["ON_DEMAND"] };
    },
    availability: async (id) => {
      calls.push(`availability ${id}`);
      return { region: "AVAILABLE", entitlement: "AVAILABLE", agreement: "AVAILABLE" };
    },
    ...overrides,
  };
}

describe("checkBedrockModel", () => {
  it("accepts an active profile whose model the account may use", async () => {
    const api = fakeBedrock();
    const result = await checkBedrockModel(
      api,
      bedrockCheck("us.anthropic.claude-sonnet-4-6"),
      "us-east-2",
    );
    expect(result.status).toBe("ok");
    expect(api.calls).toEqual([
      "profile us.anthropic.claude-sonnet-4-6",
      "availability anthropic.claude-sonnet-4-6",
    ]);
  });

  it("names a profile that doesn't exist in the region, as on the pilot", async () => {
    const result = await checkBedrockModel(
      fakeBedrock({
        inferenceProfile: async () => {
          throw new BedrockNotFound();
        },
      }),
      bedrockCheck("us.anthropic.claude-sonnet-4-6"),
      "us-east-2",
    );
    expect(result).toMatchObject({ status: "unavailable" });
    expect(describeModelProblem(result)).toBe(
      "bedrock (standard): us.anthropic.claude-sonnet-4-6: Bedrock has no inference profile us.anthropic.claude-sonnet-4-6 in us-east-2. Fix: check the ID against the profiles listed in us-east-2 (lgtmoose auth bedrock lists them).",
    );
  });

  it("says a bare model ID needs a profile when it takes no on-demand calls", async () => {
    const result = await checkBedrockModel(
      fakeBedrock({ foundationModel: async () => ({ inferenceTypes: ["INFERENCE_PROFILE"] }) }),
      bedrockCheck("anthropic.claude-sonnet-4-20250514-v1:0"),
      "us-east-2",
    );
    expect(result.status).toBe("unavailable");
    expect(result.problem).toMatch(/only be called through an inference profile/);
    expect(result.fix).toMatch(/us\.anthropic\.claude-sonnet-4-20250514-v1:0/);
  });

  it("points to the console when model access or the agreement is missing", async () => {
    const access = await checkBedrockModel(
      fakeBedrock({
        availability: async () => ({
          region: "AVAILABLE",
          entitlement: "NOT_AVAILABLE",
          agreement: "AVAILABLE",
        }),
      }),
      bedrockCheck("global.anthropic.claude-opus-4-8"),
      "us-east-2",
    );
    expect(access.problem).toBe(
      "model access to anthropic.claude-opus-4-8 isn't granted in us-east-2",
    );
    expect(access.fix).toContain(
      "https://us-east-2.console.aws.amazon.com/bedrock/home?region=us-east-2#/modelaccess",
    );
    const pending = await checkBedrockModel(
      fakeBedrock({
        availability: async () => ({
          region: "AVAILABLE",
          entitlement: "AVAILABLE",
          agreement: "PENDING",
        }),
      }),
      bedrockCheck("global.anthropic.claude-opus-4-8"),
      "us-east-2",
    );
    expect(pending.fix).toMatch(/wait/);
    const region = await checkBedrockModel(
      fakeBedrock({
        availability: async () => ({
          region: "NOT_AVAILABLE",
          entitlement: undefined,
          agreement: undefined,
        }),
      }),
      bedrockCheck("anthropic.claude-opus-4-8"),
      "eu-north-1",
    );
    expect(region.problem).toBe("anthropic.claude-opus-4-8 isn't offered in eu-north-1");
  });

  it("checks a context-window variant's base model", async () => {
    const api = fakeBedrock();
    await checkBedrockModel(
      api,
      bedrockCheck("anthropic.claude-sonnet-4-6-v1:0:200k"),
      "us-east-2",
    );
    expect(api.calls).toContain("availability anthropic.claude-sonnet-4-6-v1:0");
  });

  it("reports a failed call as unknown, not unavailable", async () => {
    const result = await checkBedrockModel(
      fakeBedrock({
        inferenceProfile: async () => {
          const error = new Error("Rate exceeded");
          error.name = "ThrottlingException";
          throw error;
        },
      }),
      bedrockCheck("us.anthropic.claude-sonnet-4-6"),
      "us-east-2",
    );
    expect(result).toMatchObject({
      status: "unknown",
      problem: "couldn't check: ThrottlingException: Rate exceeded",
    });
  });

  it("refuses an ID that isn't a Bedrock one", async () => {
    const result = await checkBedrockModel(
      fakeBedrock(),
      bedrockCheck("claude-sonnet-4-6"),
      "us-east-2",
    );
    expect(result.status).toBe("unavailable");
  });
});

describe("checkApiModel", () => {
  const anthropic: ModelToCheck = {
    providerId: "anthropic",
    kind: "anthropic-api",
    model: "claude-sonnet-4-6",
    tiers: ["standard"],
  };
  const openai: ModelToCheck = {
    ...anthropic,
    providerId: "openai",
    kind: "openai-api",
    model: "gpt-5-codex",
  };

  it("asks the model endpoint with the key in a header only", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const get = async (url: string, headers: Record<string, string>) => {
      seen.push({ url, headers });
      return 200;
    };
    expect((await checkApiModel(get, anthropic, " sk-ant-secret \n")).status).toBe("ok");
    expect((await checkApiModel(get, openai, "sk-openai")).status).toBe("ok");
    expect(seen).toEqual([
      {
        url: "https://api.anthropic.com/v1/models/claude-sonnet-4-6",
        headers: { "x-api-key": "sk-ant-secret", "anthropic-version": "2023-06-01" },
      },
      {
        url: "https://api.openai.com/v1/models/gpt-5-codex",
        headers: { authorization: "Bearer sk-openai" },
      },
    ]);
  });

  it("tells a missing model from a refused key, and never repeats the key", async () => {
    const missing = await checkApiModel(async () => 404, anthropic, "sk-ant-secret");
    expect(missing).toMatchObject({ status: "unavailable" });
    expect(missing.problem).toMatch(/no model claude-sonnet-4-6/);
    const refused = await checkApiModel(async () => 401, openai, "sk-openai");
    expect(refused.problem).toBe("the OpenAI API refused the stored key (HTTP 401)");
    const odd = await checkApiModel(async () => 503, openai, "sk-openai");
    expect(odd.status).toBe("unknown");
    const failed = await checkApiModel(
      async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      openai,
      "sk-openai",
    );
    expect(failed.status).toBe("unknown");
    for (const result of [missing, refused, odd, failed]) {
      expect(JSON.stringify(result)).not.toMatch(/sk-ant-secret|sk-openai/);
    }
  });
});
