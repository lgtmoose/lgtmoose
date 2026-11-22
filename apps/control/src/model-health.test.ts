import { BedrockNotFound, type BedrockModelApi, type ModelToCheck } from "@lgtmoose/config";
import { describe, expect, it, vi } from "vitest";
import {
  MODEL_CHECK_RESERVE_MS,
  checkModels,
  healthCheck,
  modelChecksSchema,
} from "./model-health.js";

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
      return { status: "ACTIVE" };
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
          "bedrock (standard, deep): us.anthropic.claude-sonnet-4-6: Bedrock has no inference profile us.anthropic.claude-sonnet-4-6 in us-east-2. Fix: check the ID against the profiles pnpm lgtmoose auth bedrock --id bedrock lists for us-east-2.",
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

  it("clears the alarm when the rest pass, though one model is always unknown", async () => {
    // Otherwise one model that can never be read keeps the alarm up after a fix, forever.
    const out = recorder();
    await checkModels({
      checks: [
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
        bedrock("us.anthropic.claude-sonnet-4-6", ["standard", "deep"]),
      ],
      region: "us-east-2",
      bedrock: api([], ["us.anthropic.claude-haiku-4-5-20251001-v1:0"]),
      report: out.report,
      log: out.log,
    });
    expect(out.reports).toEqual([["bedrock", 0, undefined]]);
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
          return { status: url.endsWith("claude-sonnet-9") ? 404 : 200 };
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
    // A provider with no readable key is named, not passed over silently.
    expect(out.logs).toContainEqual([
      "model not checked: no stored key",
      { providerId: "nokey", model: "gpt-5-codex" },
    ]);
  });

  it("skips Bedrock without a client, says so once, and skips API keys without a reader", async () => {
    const out = recorder();
    const results = await checkModels({
      checks: [
        bedrock("us.anthropic.claude-sonnet-4-6"),
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
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
    expect(out.logs).toEqual([
      ["Bedrock models not checked: no Bedrock client here", { providers: ["bedrock"] }],
    ]);
  });

  it("clears the alarm for active profiles whose model access can't be read in this region", async () => {
    // eu-north-1 doesn't offer the models itself, so access always reads NOT_AVAILABLE: without
    // a status of its own, the provider would never write 0 and the alarm would stay up.
    const out = recorder();
    const results = await checkModels({
      checks: [
        bedrock("global.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
        bedrock("eu.anthropic.claude-sonnet-4-6", ["standard", "deep"]),
      ],
      region: "eu-north-1",
      bedrock: {
        ...api(),
        availability: async () => ({
          region: "NOT_AVAILABLE",
          entitlement: "NOT_AVAILABLE",
          agreement: "AVAILABLE",
        }),
      },
      report: out.report,
      log: out.log,
    });
    expect(results.map((result) => result.status)).toEqual(["unverified", "unverified"]);
    expect(out.reports).toEqual([["bedrock", 0, undefined]]);
    expect(out.logs.map(([message]) => message)).toEqual([
      "model access not verified: the profile is active",
      "model access not verified: the profile is active",
    ]);
  });

  it("reports each provider as soon as its checks finish", async () => {
    const events: string[] = [];
    await checkModels({
      checks: [
        bedrock("us.anthropic.claude-sonnet-4-6"),
        { providerId: "openai", kind: "openai-api", model: "gpt-5-codex", tiers: ["deep"] },
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
      ],
      region: "us-east-2",
      bedrock: api(),
      api: {
        get: async () => {
          events.push("openai checked");
          return { status: 200 };
        },
        key: async () => "k",
      },
      report: (providerId) => events.push(`${providerId} reported`),
      log: () => undefined,
    });
    // Bedrock's two models are checked together, then reported before OpenAI is asked.
    expect(events).toEqual(["bedrock reported", "openai checked", "openai reported"]);
  });

  it("starts no check with less than the worst-case check left, and still reports what it found", async () => {
    const out = recorder();
    let left = 60_000;
    const asked: string[] = [];
    const bedrockApi = api(["us.anthropic.claude-sonnet-4-6"]);
    const results = await checkModels({
      checks: [
        bedrock("us.anthropic.claude-sonnet-4-6"),
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
        { providerId: "openai", kind: "openai-api", model: "gpt-5-codex", tiers: ["deep"] },
      ],
      region: "us-east-2",
      bedrock: {
        ...bedrockApi,
        inferenceProfile: async (id) => {
          asked.push(id);
          left -= 45_000;
          return bedrockApi.inferenceProfile(id);
        },
      },
      api: { get: async () => ({ status: 200 }), key: async () => "k" },
      remainingMs: () => left,
      report: out.report,
      log: out.log,
    });
    expect(asked).toEqual(["us.anthropic.claude-sonnet-4-6"]);
    expect(results.map((result) => result.status)).toEqual(["unavailable"]);
    // An unfinished provider still raises the alarm for what failed, but never clears it.
    expect(out.reports.map(([id, value]) => [id, value])).toEqual([["bedrock", 1]]);
    expect(out.logs).toContainEqual([
      "model checks stopped: the invocation is nearly out of time",
      { notFinished: ["bedrock", "openai"] },
    ]);
  });

  it("clears nothing for a provider it ran out of time on", async () => {
    const out = recorder();
    let left = 100_000;
    await checkModels({
      checks: [
        bedrock("us.anthropic.claude-sonnet-4-6"),
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
      ],
      region: "us-east-2",
      bedrock: {
        ...api(),
        inferenceProfile: async () => {
          left = 5_000;
          return { status: "ACTIVE" };
        },
      },
      remainingMs: () => left,
      report: out.report,
      log: out.log,
    });
    expect(left).toBe(5_000);
    expect(out.reports).toEqual([]);
  });

  it("reports an unavailable model at once, before a later check that never returns", async () => {
    // The Lambda is killed mid-check: what it found before that must already be reported.
    const out = recorder();
    const working = api(["us.anthropic.claude-sonnet-4-6"]);
    let hung = false;
    void checkModels({
      checks: [
        bedrock("us.anthropic.claude-sonnet-4-6"),
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
      ],
      region: "us-east-2",
      bedrock: {
        ...working,
        inferenceProfile: (id) => {
          if (id === "us.anthropic.claude-sonnet-4-6") return working.inferenceProfile(id);
          hung = true;
          return new Promise(() => undefined);
        },
      },
      remainingMs: () => 10 * 60_000,
      report: out.report,
      log: out.log,
    });
    await vi.waitFor(() => expect(hung).toBe(true));
    expect(out.reports).toEqual([
      [
        "bedrock",
        1,
        [
          expect.stringContaining(
            "us.anthropic.claude-sonnet-4-6: Bedrock has no inference profile us.anthropic.claude-sonnet-4-6 in us-east-2.",
          ),
        ],
      ],
    ]);
  });

  it("reports every unavailable model so far each time another is found", async () => {
    const out = recorder();
    await checkModels({
      checks: [
        bedrock("us.anthropic.claude-sonnet-4-6"),
        bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0", ["fast"]),
      ],
      region: "us-east-2",
      bedrock: api([
        "us.anthropic.claude-sonnet-4-6",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      ]),
      report: out.report,
      log: out.log,
    });
    expect(out.reports.map(([id, value, problems]) => [id, value, problems?.length])).toEqual([
      ["bedrock", 1, 1],
      ["bedrock", 1, 2],
    ]);
  });

  it("keeps room for one worst-case check, and some to spare", () => {
    expect(MODEL_CHECK_RESERVE_MS).toBe(60_000);
  });
});

describe("healthCheck", () => {
  const credentials = async () => ({ claude: undefined });

  it("still returns the credential check when the Bedrock client can't be loaded", async () => {
    const out = recorder();
    const result = await healthCheck({
      credentials,
      checks: () => [bedrock("us.anthropic.claude-sonnet-4-6")],
      region: "us-east-2",
      bedrock: async () => {
        throw new Error("@aws-sdk/client-bedrock has no GetFoundationModelAvailabilityCommand.");
      },
      report: out.report,
      log: out.log,
    });
    expect(result).toEqual({ credentials: { claude: undefined }, models: {} });
    expect(out.reports).toEqual([]);
    expect(out.logs[0]?.[0]).toBe("model checks not run: no Bedrock client");
  });

  it("still returns the credential check when the model checks don't parse", async () => {
    const out = recorder();
    const result = await healthCheck({
      credentials,
      checks: () => modelChecksSchema.parse([{ kind: "vertex" }]),
      region: "us-east-2",
      bedrock: async () => api(),
      report: out.report,
      log: out.log,
    });
    expect(result.credentials).toEqual({ claude: undefined });
    expect(out.logs[0]?.[0]).toBe("model checks failed");
  });

  it("still runs the model checks when the credential check throws, then throws its error", async () => {
    const out = recorder();
    const failure = new Error("Secrets Manager is down");
    await expect(
      healthCheck({
        credentials: () => Promise.reject(failure),
        checks: () => [bedrock("us.anthropic.claude-sonnet-4-6")],
        region: "us-east-2",
        bedrock: async () => api(["us.anthropic.claude-sonnet-4-6"]),
        report: out.report,
        log: out.log,
      }),
    ).rejects.toBe(failure);
    expect(out.reports.map(([id, value]) => [id, value])).toEqual([["bedrock", 1]]);
  });

  it("runs the credential check first, then the models", async () => {
    const order: string[] = [];
    const out = recorder();
    const result = await healthCheck({
      credentials: async () => {
        order.push("credentials");
        return {};
      },
      checks: () => [bedrock("us.anthropic.claude-sonnet-4-6")],
      region: "us-east-2",
      bedrock: async () => {
        order.push("bedrock");
        return api();
      },
      report: out.report,
      log: out.log,
    });
    expect(order).toEqual(["credentials", "bedrock"]);
    expect(result.models).toEqual({ "bedrock:us.anthropic.claude-sonnet-4-6": "ok" });
  });

  it("passes the invocation's remaining time to the model checks", async () => {
    const out = recorder();
    const result = await healthCheck({
      credentials: async () => ({}),
      checks: () => [bedrock("us.anthropic.claude-sonnet-4-6")],
      region: "us-east-2",
      bedrock: async () => api(),
      remainingMs: () => 1_000,
      report: out.report,
      log: out.log,
    });
    expect(result.models).toEqual({});
    expect(out.reports).toEqual([]);
  });

  it("loads no Bedrock client when no Bedrock model is checked", async () => {
    let loaded = false;
    const out = recorder();
    await healthCheck({
      credentials,
      checks: () => [],
      region: "us-east-2",
      bedrock: async () => {
        loaded = true;
        return api();
      },
      report: out.report,
      log: out.log,
    });
    expect(loaded).toBe(false);
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
