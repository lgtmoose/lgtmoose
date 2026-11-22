import { BedrockNotFound, type BedrockModelApi, type ModelToCheck } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { checkModels, modelChecksSchema } from "./model-health.js";

const bedrock = (model: string, tiers: ModelToCheck["tiers"] = ["standard"]): ModelToCheck => ({
  providerId: "bedrock",
  kind: "bedrock",
  model,
  tiers,
});

function api(missing: readonly string[] = [], failing: readonly string[] = []): BedrockModelApi {
  return {
    inferenceProfile: async (id) => {
      if (failing.includes(id)) {
        const error = new Error("Rate exceeded");
        error.name = "ThrottlingException";
        throw error;
      }
      if (missing.includes(id)) throw new BedrockNotFound();
      return { status: "ACTIVE", modelIds: [] };
    },
    foundationModel: async () => ({ inferenceTypes: ["ON_DEMAND"] }),
    availability: async () => ({
      region: "AVAILABLE",
      entitlement: "AVAILABLE",
      agreement: "AVAILABLE",
    }),
  };
}

function recorder() {
  const reports: [string, 0 | 1, string[] | undefined][] = [];
  const logs: [string, Record<string, unknown> | undefined][] = [];
  return {
    reports,
    logs,
    report: (providerId: string, value: 0 | 1, problems?: string[]) => {
      reports.push([providerId, value, problems]);
    },
    log: (message: string, fields?: Record<string, unknown>) => {
      logs.push([message, fields]);
    },
  };
}

describe("checkModels", () => {
  it("marks a provider unhealthy when one of its models can't be called, and logs where", async () => {
    const out = recorder();
    const results = await checkModels({
      checks: [
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
        bedrock("us.anthropic.claude-sonnet-4-6", ["standard", "deep"]),
      ],
      region: "us-east-2",
      bedrock: api(["us.anthropic.claude-sonnet-4-6"]),
      report: out.report,
      log: out.log,
    });
    expect(results.map((result) => result.status)).toEqual(["ok", "unavailable"]);
    expect(out.reports).toEqual([
      [
        "bedrock",
        1,
        [
          "bedrock (standard, deep): us.anthropic.claude-sonnet-4-6: Bedrock has no inference profile us.anthropic.claude-sonnet-4-6 in us-east-2. Fix: check the ID against the profiles listed in us-east-2 (lgtmoose auth bedrock lists them).",
        ],
      ],
    ]);
    expect(out.logs).toEqual([
      [
        "model unavailable",
        expect.objectContaining({
          providerId: "bedrock",
          tiers: ["standard", "deep"],
          model: "us.anthropic.claude-sonnet-4-6",
          region: "us-east-2",
        }),
      ],
    ]);
  });

  it("clears the alarm when every model passes, and leaves it when a check couldn't run", async () => {
    const ok = recorder();
    await checkModels({
      checks: [bedrock("us.anthropic.claude-sonnet-4-6")],
      region: "us-east-2",
      bedrock: api(),
      report: ok.report,
      log: ok.log,
    });
    expect(ok.reports).toEqual([["bedrock", 0, undefined]]);

    const throttled = recorder();
    const results = await checkModels({
      checks: [bedrock("us.anthropic.claude-sonnet-4-6")],
      region: "us-east-2",
      bedrock: api([], ["us.anthropic.claude-sonnet-4-6"]),
      report: throttled.report,
      log: throttled.log,
    });
    expect(results[0]?.status).toBe("unknown");
    expect(throttled.reports).toEqual([]);
    expect(throttled.logs[0]?.[0]).toBe("model not checked");
  });

  it("checks API-key models only where a key can be read, and never reports the key", async () => {
    const out = recorder();
    const asked: Record<string, string>[] = [];
    const results = await checkModels({
      checks: [
        {
          providerId: "anthropic",
          kind: "anthropic-api",
          model: "claude-sonnet-9",
          tiers: ["standard"],
        },
        { providerId: "openai", kind: "openai-api", model: "gpt-5-codex", tiers: ["standard"] },
        { providerId: "nokey", kind: "openai-api", model: "gpt-5-codex", tiers: ["standard"] },
      ],
      region: "us-east-1",
      api: {
        get: async (url, headers) => {
          asked.push(headers);
          return url.endsWith("claude-sonnet-9") ? 404 : 200;
        },
        key: async (providerId) => {
          if (providerId === "nokey") return undefined;
          if (providerId === "openai") return "sk-openai-STORED";
          return "sk-ant-STORED";
        },
      },
      report: out.report,
      log: out.log,
    });
    expect(results.map((result) => [result.providerId, result.status])).toEqual([
      ["anthropic", "unavailable"],
      ["openai", "ok"],
    ]);
    expect(asked).toHaveLength(2);
    expect(out.reports.map(([id, value]) => [id, value])).toEqual([
      ["anthropic", 1],
      ["openai", 0],
    ]);
    expect(JSON.stringify([out.reports, out.logs])).not.toMatch(/STORED/);
  });

  it("skips Bedrock without a client and API keys without a reader", async () => {
    const out = recorder();
    const results = await checkModels({
      checks: [
        bedrock("us.anthropic.claude-sonnet-4-6"),
        {
          providerId: "anthropic",
          kind: "anthropic-api",
          model: "claude-sonnet-4-6",
          tiers: ["fast"],
        },
      ],
      region: "us-east-2",
      report: out.report,
      log: out.log,
    });
    expect(results).toEqual([]);
    expect(out.reports).toEqual([]);
  });
});

describe("modelChecksSchema", () => {
  it("reads the stack's LGTMOOSE_MODEL_CHECKS and refuses anything else", () => {
    const checks = [bedrock("us.anthropic.claude-sonnet-4-6", ["standard", "deep"])];
    expect(modelChecksSchema.parse(JSON.parse(JSON.stringify(checks)))).toEqual(checks);
    expect(() => modelChecksSchema.parse([{ ...checks[0], kind: "vertex" }])).toThrow();
    expect(() => modelChecksSchema.parse([{ ...checks[0], extra: 1 }])).toThrow();
  });
});
