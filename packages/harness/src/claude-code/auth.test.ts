import { describe, expect, it } from "vitest";
import { HarnessError } from "../harness.js";
import { claudeAuthEnv, networkEnv } from "./auth.js";

describe("claudeAuthEnv", () => {
  it("uses an OAuth token from claude setup-token", () => {
    const auth = claudeAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abcdefgh", HOME: "/root" });
    expect(auth).toEqual({
      method: "oauth_token",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abcdefgh" },
      secrets: ["sk-ant-oat01-abcdefgh"],
    });
  });

  it("prefers an API key and passes only that", () => {
    const auth = claudeAuthEnv({
      ANTHROPIC_API_KEY: "sk-ant-api03-abcdefgh",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abcdefgh",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
    });
    expect(auth.method).toBe("api_key");
    expect(auth.env).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-api03-abcdefgh",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
    });
  });

  it("uses Bedrock with a task role and keeps unrelated AWS settings out", () => {
    const auth = claudeAuthEnv({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "container-token-123",
      ANTHROPIC_API_KEY: "sk-ant-api03-abcdefgh",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5",
      DATABASE_URL: "postgres://u:p@db/x",
    });
    expect(auth.method).toBe("bedrock");
    expect(auth.env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/abc",
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "container-token-123",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5",
    });
    expect(auth.secrets).toEqual(["container-token-123"]);
  });

  it("collects AWS keys as secrets", () => {
    const auth = claudeAuthEnv({
      CLAUDE_CODE_USE_BEDROCK: "true",
      AWS_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEY",
      AWS_SECRET_ACCESS_KEY: "secret-access-key",
      AWS_SESSION_TOKEN: "session-token-value",
    });
    expect(auth.secrets.sort()).toEqual(
      ["AKIAEXAMPLEKEY", "secret-access-key", "session-token-value"].sort(),
    );
  });

  it("requires AWS_REGION for Bedrock", () => {
    expect(() => claudeAuthEnv({ CLAUDE_CODE_USE_BEDROCK: "1" })).toThrow(/AWS_REGION/);
  });

  it("treats 0 and false as off", () => {
    const auth = claudeAuthEnv({
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "false",
      ANTHROPIC_API_KEY: "sk-ant-api03-abcdefgh",
    });
    expect(auth.method).toBe("api_key");
  });

  it("uses Vertex with its project, region and per-model regions", () => {
    const auth = claudeAuthEnv({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "proj",
      CLOUD_ML_REGION: "us-east5",
      VERTEX_REGION_CLAUDE_HAIKU_4_5: "europe-west1",
      GOOGLE_APPLICATION_CREDENTIALS: "/var/run/gcp.json",
      AWS_REGION: "us-east-1",
    });
    expect(auth.method).toBe("vertex");
    expect(auth.env).toEqual({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "proj",
      CLOUD_ML_REGION: "us-east5",
      VERTEX_REGION_CLAUDE_HAIKU_4_5: "europe-west1",
      GOOGLE_APPLICATION_CREDENTIALS: "/var/run/gcp.json",
    });
  });

  it("requires the Vertex project and region", () => {
    expect(() => claudeAuthEnv({ CLAUDE_CODE_USE_VERTEX: "1" })).toThrow(
      /ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION/,
    );
  });

  it("fails with an auth error when there's no credential", () => {
    let error: unknown;
    try {
      claudeAuthEnv({ PATH: "/usr/bin", GITHUB_TOKEN: "ghs_x" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HarnessError);
    expect((error as HarnessError).kind).toBe("auth");
    expect((error as HarnessError).message).toContain("claude setup-token");
  });
});

describe("networkEnv", () => {
  it("keeps proxy and CA settings only", () => {
    expect(
      networkEnv({ HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem", FOO: "x" }),
    ).toEqual({ HTTPS_PROXY: "http://proxy:3128", NODE_EXTRA_CA_CERTS: "/ca.pem" });
  });
});
