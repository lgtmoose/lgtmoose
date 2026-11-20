import { describe, expect, it } from "vitest";
import { readSandboxEnv } from "./env.js";

describe("readSandboxEnv", () => {
  it("reads every setting", () => {
    expect(
      readSandboxEnv({
        LGTMOOSE_PROVIDER: "claude",
        HTTPS_PROXY: "http://egress-proxy.lgtmoose.internal:3128",
        LGTMOOSE_HARNESS: "claude-code",
        LGTMOOSE_AUTH: "oauth-token",
        LGTMOOSE_BATCH_URLS: "https://bucket.s3.amazonaws.com/urls.json?sig",
      }),
    ).toEqual({
      providerId: "claude",
      httpsProxy: "http://egress-proxy.lgtmoose.internal:3128",
      harness: "claude-code",
      auth: "oauth-token",
      batchUrls: "https://bucket.s3.amazonaws.com/urls.json?sig",
    });
  });

  it("reads the provider's model, with `default` for the harness's own", () => {
    const env = {
      LGTMOOSE_PROVIDER: "codex",
      HTTPS_PROXY: "http://proxy:3128",
      LGTMOOSE_HARNESS: "codex",
      LGTMOOSE_AUTH: "chatgpt-login",
      LGTMOOSE_BATCH_URLS: "https://bucket/urls.json",
    };
    expect(readSandboxEnv({ ...env, LGTMOOSE_MODEL: "gpt-5.1-codex" })).toMatchObject({
      model: "gpt-5.1-codex",
    });
    expect(readSandboxEnv({ ...env, LGTMOOSE_MODEL: "default" })).toMatchObject({ model: "" });
    expect(readSandboxEnv(env)).not.toHaveProperty("model");
    expect(readSandboxEnv(env)).not.toHaveProperty("thinkingTokens");
    expect(
      readSandboxEnv({
        ...env,
        LGTMOOSE_THINKING_TOKENS: "2000",
        LGTMOOSE_FAST_THINKING_TOKENS: "1024",
      }),
    ).toMatchObject({ thinkingTokens: 2000, fastThinkingTokens: 1024 });
    expect(readSandboxEnv({ ...env, LGTMOOSE_THINKING_TOKENS: "200" })).not.toHaveProperty(
      "thinkingTokens",
    );
    expect(readSandboxEnv(env)).not.toHaveProperty("effort");
    expect(
      readSandboxEnv({ ...env, LGTMOOSE_EFFORT: "medium", LGTMOOSE_FAST_EFFORT: "low" }),
    ).toMatchObject({ effort: "medium", fastEffort: "low" });
    expect(readSandboxEnv({ ...env, LGTMOOSE_EFFORT: "turbo" })).not.toHaveProperty("effort");
    expect(readSandboxEnv({ ...env, LGTMOOSE_FAST_EFFORT: "turbo" })).not.toHaveProperty(
      "fastEffort",
    );
    expect(readSandboxEnv({ ...env, LGTMOOSE_DEEP_EFFORT: "high" })).toMatchObject({
      deepEffort: "high",
    });
    expect(readSandboxEnv({ ...env, LGTMOOSE_DEEP_EFFORT: "turbo" })).not.toHaveProperty(
      "deepEffort",
    );
  });

  it("names the missing ones", () => {
    expect(readSandboxEnv({ LGTMOOSE_PROVIDER: "claude", LGTMOOSE_AUTH: " " })).toEqual({
      missing: ["HTTPS_PROXY", "LGTMOOSE_HARNESS", "LGTMOOSE_AUTH", "LGTMOOSE_BATCH_URLS"],
    });
  });
});
