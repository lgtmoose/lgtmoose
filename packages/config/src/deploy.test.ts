import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import {
  defineConfig,
  modelFor,
  parseDeployConfig,
  providerChain,
  resolveRoles,
  type DeployConfigInput,
} from "./deploy.js";

const minimal = {
  allowedOrgs: ["lgtmoose"],
  providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
} satisfies DeployConfigInput;

function issuesOf(input: unknown) {
  try {
    parseDeployConfig(input);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected parseDeployConfig to throw");
}

describe("parseDeployConfig", () => {
  it("fills defaults for a minimal config", () => {
    expect(parseDeployConfig(minimal)).toEqual({
      region: "us-east-1",
      profile: "lean",
      allowedOrgs: ["lgtmoose"],
      providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
      roles: {},
      maxConcurrency: 4,
      shadow: true,
      extraEgressHosts: [],
      dashboard: true,
    });
  });

  it("accepts a full multi-provider config", () => {
    const config = parseDeployConfig(
      defineConfig({
        region: "eu-west-2",
        profile: "standard",
        allowedOrgs: ["lgtmoose", "partake-technologies"],
        providers: [
          { id: "claude", harness: "claude-code", auth: "oauth-token", models: { deep: "opus" } },
          { id: "chatgpt", harness: "codex", auth: "chatgpt-login" },
          { id: "cursor", harness: "cursor-agent", auth: "service-account" },
        ],
        roles: { reviewer: "claude", verifier: "chatgpt" },
        maxConcurrency: 8,
        extraEgressHosts: ["models.internal.example.com"],
        tickets: { provider: "linear" },
        dashboard: false,
      }),
    );
    expect(config.providers).toHaveLength(3);
    expect(config.tickets).toEqual({ provider: "linear" });
  });

  it("rejects an auth method the harness doesn't support, naming the key", () => {
    const issues = issuesOf({
      ...minimal,
      providers: [{ id: "c", harness: "cursor-agent", auth: "bedrock" }],
    });
    expect(issues).toEqual([
      {
        path: "providers[0].auth",
        message: 'cursor-agent doesn\'t support "bedrock". Use one of: api-key, service-account',
      },
    ]);
  });

  it("rejects roles that point at unknown providers", () => {
    const issues = issuesOf({ ...minimal, roles: { verifier: "gpt" } });
    expect(issues[0]?.path).toBe("roles.verifier");
    expect(issues[0]?.message).toContain('no provider with id "gpt"');
  });

  it("rejects duplicate provider ids", () => {
    const issues = issuesOf({
      ...minimal,
      providers: [
        { id: "claude", harness: "claude-code", auth: "bedrock" },
        { id: "claude", harness: "agent-sdk", auth: "api-key" },
      ],
    });
    expect(issues).toEqual([
      { path: "providers[1].id", message: 'duplicate provider id "claude"' },
    ]);
  });

  it("rejects unknown keys, so typos don't pass silently", () => {
    const issues = issuesOf({ ...minimal, dashbaord: false });
    expect(issues[0]?.message).toMatch(/dashbaord/);
  });

  it("requires at least one org and one provider", () => {
    const paths = issuesOf({ allowedOrgs: [], providers: [] }).map((issue) => issue.path);
    expect(paths).toEqual(["allowedOrgs", "providers"]);
  });

  it("rejects wildcard egress hosts", () => {
    const issues = issuesOf({ ...minimal, extraEgressHosts: ["*.example.com"] });
    expect(issues[0]?.path).toBe("extraEgressHosts[0]");
  });

  it("puts every issue in the error message", () => {
    expect(() => parseDeployConfig({ allowedOrgs: [], providers: [] })).toThrow(
      /lgtmoose\.config\.ts is invalid:\n {2}- allowedOrgs: .*\n {2}- providers: /,
    );
  });
});

describe("resolveRoles", () => {
  it("uses the assigned provider, or the first provider when unassigned", () => {
    const config = parseDeployConfig({
      ...minimal,
      providers: [...minimal.providers, { id: "chatgpt", harness: "codex", auth: "api-key" }],
      roles: { verifier: "chatgpt" },
    });
    const roles = resolveRoles(config);
    expect(roles.verifier.id).toBe("chatgpt");
    expect(roles.reviewer.id).toBe("claude");
    expect(roles.ticketExtractor.id).toBe("claude");
  });
});

describe("modelFor", () => {
  it("uses the provider's model for a tier, else the harness default", () => {
    const config = parseDeployConfig({
      ...minimal,
      providers: [
        {
          id: "claude",
          harness: "claude-code",
          auth: "bedrock",
          models: { deep: "claude-opus-5-5" },
        },
        { id: "chatgpt", harness: "codex", auth: "api-key" },
      ],
    });
    const [claude, chatgpt] = config.providers;
    expect(claude && modelFor(claude, "deep")).toBe("claude-opus-5-5");
    expect(claude && modelFor(claude, "fast")).toBe("haiku");
    expect(claude && modelFor(claude, "standard")).toBe("sonnet");
    // Codex picks its own default model and maps the tier to a reasoning effort.
    expect(chatgpt && modelFor(chatgpt, "deep")).toBeUndefined();
  });

  it("refuses a model name with spaces or quotes", () => {
    const issues = issuesOf({
      ...minimal,
      providers: [
        { id: "claude", harness: "claude-code", auth: "bedrock", models: { fast: 'x" --y' } },
      ],
    });
    expect(issues.map((issue) => issue.path)).toContain("providers[0].models.fast");
  });
});

describe("providerChain", () => {
  it("starts on the role's provider and falls back to the others in order", () => {
    const config = parseDeployConfig({
      ...minimal,
      providers: [
        ...minimal.providers,
        { id: "chatgpt", harness: "codex", auth: "api-key" },
        { id: "bedrock2", harness: "claude-code", auth: "bedrock" },
      ],
      roles: { verifier: "chatgpt" },
    });
    const ids = (role: "verifier" | "reviewer") => providerChain(config, role).map((p) => p.id);
    expect(ids("verifier")).toEqual(["chatgpt", "claude", "bedrock2"]);
    expect(ids("reviewer")).toEqual(["claude", "chatgpt", "bedrock2"]);
  });
});
