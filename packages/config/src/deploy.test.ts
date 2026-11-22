import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import {
  credentialConcurrency,
  defineConfig,
  isPlanCredential,
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
  it("wants the reconciler's lookback to cover at least its interval", () => {
    expect(
      issuesOf({ ...minimal, reconcileIntervalMinutes: 120, reconcileLookbackHours: 1 }),
    ).toEqual([expect.objectContaining({ path: "reconcileLookbackHours" })]);
    expect(
      parseDeployConfig({ ...minimal, reconcileIntervalMinutes: 60, reconcileLookbackHours: 1 }),
    ).toMatchObject({ reconcileLookbackHours: 1 });
  });

  it("caps thinking per tier and rejects a budget under the CLI's floor", () => {
    expect(
      parseDeployConfig({
        ...minimal,
        providers: [
          {
            id: "claude",
            harness: "claude-code",
            auth: "bedrock",
            thinkingTokens: { standard: 2000 },
          },
        ],
      }).providers[0],
    ).toMatchObject({ thinkingTokens: { standard: 2000 } });
    expect(
      issuesOf({
        ...minimal,
        providers: [
          { id: "claude", harness: "claude-code", auth: "bedrock", thinkingTokens: { fast: 200 } },
        ],
      }),
    ).toEqual([expect.objectContaining({ path: "providers[0].thinkingTokens.fast" })]);
  });

  it("fills defaults for a minimal config", () => {
    expect(parseDeployConfig(minimal)).toEqual({
      region: "us-east-1",
      profile: "lean",
      allowedOrgs: ["lgtmoose"],
      providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
      roles: {},
      maxConcurrency: 4,
      batchStaggerSeconds: 30,
      reconcileIntervalMinutes: 30,
      reconcileLookbackHours: 24,
      maxReplyJudgements: 10,
      maxExplanations: 5,
      commandAliases: [],
      reviewDebounceSeconds: 60,
      feedback: { acceptanceThreshold: 0.5, minSamples: 3, maxCommentsPerRun: 100 },
      alarms: {},
      images: { source: "build" },
      budgets: { perPullRequest: {}, prices: {} },
      shadow: true,
      extraEgressHosts: [],
      learnings: {
        embeddings: { provider: "none" },
        maxPendingPerAuthor: 5,
        repeatThreshold: 2,
        bootstrapMaxCostUsd: 5,
      },
      dashboard: true,
    });
  });

  it("builds the images by default, or takes a release's images pinned by digest", () => {
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const release = {
      source: "release" as const,
      version: "0.1.0",
      digests: { control: digest("a"), sandbox: digest("b"), egressProxy: digest("c") },
    };
    expect(parseDeployConfig({ ...minimal, images: release }).images).toEqual({
      ...release,
      registry: "ghcr.io/lgtmoose",
    });
    expect(
      issuesOf({
        ...minimal,
        images: { ...release, digests: { ...release.digests, control: "latest" } },
      }),
    ).toContainEqual(expect.objectContaining({ path: "images.digests.control" }));
    expect(
      issuesOf({ ...minimal, images: { source: "release", version: "0.1.0" } }),
    ).toContainEqual(expect.objectContaining({ path: "images.digests" }));
    // A release's sandbox image has no Cursor CLI.
    expect(
      issuesOf({
        ...minimal,
        images: release,
        providers: [{ id: "cursor", harness: "cursor-agent", auth: "api-key" }],
      }),
    ).toContainEqual(expect.objectContaining({ path: "providers[0].harness" }));
  });

  it("takes a pending-learnings limit per author between 1 and 100", () => {
    expect(
      parseDeployConfig({ ...minimal, learnings: { maxPendingPerAuthor: 2 } }).learnings,
    ).toEqual({
      embeddings: { provider: "none" },
      maxPendingPerAuthor: 2,
      repeatThreshold: 2,
      bootstrapMaxCostUsd: 5,
    });
    expect(issuesOf({ ...minimal, learnings: { maxPendingPerAuthor: 0 } })).toEqual([
      expect.objectContaining({ path: "learnings.maxPendingPerAuthor" }),
    ]);
  });

  it("takes up to 5 command aliases that look like GitHub logins (NIC-1119)", () => {
    expect(parseDeployConfig({ ...minimal, commandAliases: ["lgtmoose"] }).commandAliases).toEqual([
      "lgtmoose",
    ]);
    for (const commandAliases of [
      ["@lgtmoose"],
      ["has space"],
      ["-leading"],
      ["double--hyphen"],
      ["x".repeat(40)],
      ["a", "b", "c", "d", "e", "f"],
    ]) {
      expect(() => parseDeployConfig({ ...minimal, commandAliases })).toThrow();
    }
  });

  it("takes a repeat threshold of at least 2 PRs for learnings from rejections", () => {
    expect(
      parseDeployConfig({ ...minimal, learnings: { repeatThreshold: 3 } }).learnings
        .repeatThreshold,
    ).toBe(3);
    expect(issuesOf({ ...minimal, learnings: { repeatThreshold: 1 } })).toEqual([
      expect.objectContaining({ path: "learnings.repeatThreshold" }),
    ]);
  });

  it("takes an embeddings provider for learnings, with each one's default model", () => {
    expect(
      parseDeployConfig({ ...minimal, learnings: { embeddings: { provider: "bedrock" } } })
        .learnings,
    ).toEqual({
      embeddings: { provider: "bedrock", model: "amazon.titan-embed-text-v2:0" },
      maxPendingPerAuthor: 5,
      repeatThreshold: 2,
      bootstrapMaxCostUsd: 5,
    });
    expect(
      parseDeployConfig({ ...minimal, learnings: { embeddings: { provider: "openai" } } })
        .learnings,
    ).toEqual({
      embeddings: { provider: "openai", model: "text-embedding-3-small" },
      maxPendingPerAuthor: 5,
      repeatThreshold: 2,
      bootstrapMaxCostUsd: 5,
    });
    expect(
      issuesOf({
        ...minimal,
        learnings: { embeddings: { provider: "openai", model: "ada-002" } },
      }),
    ).toEqual([expect.objectContaining({ path: "learnings.embeddings.model" })]);
  });

  it("accepts a full multi-provider config", () => {
    const config = parseDeployConfig(
      defineConfig({
        region: "eu-west-2",
        profile: "standard",
        allowedOrgs: ["lgtmoose", "example-org"],
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
    expect(config.tickets).toEqual({
      provider: "linear",
      maxPerPullRequest: 3,
      teamKeys: [],
      detailsOnPublicRepos: false,
    });
  });

  it("refuses ticket providers that aren't built and bad ticket settings", () => {
    expect(issuesOf({ ...minimal, tickets: { provider: "jira" } })).toContainEqual(
      expect.objectContaining({ path: "tickets.provider" }),
    );
    expect(
      issuesOf({ ...minimal, tickets: { provider: "linear", maxPerPullRequest: 11 } }),
    ).toContainEqual(expect.objectContaining({ path: "tickets.maxPerPullRequest" }));
    expect(
      issuesOf({ ...minimal, tickets: { provider: "linear", teamKeys: ["ENG-1"] } }),
    ).toContainEqual(expect.objectContaining({ path: "tickets.teamKeys[0]" }));
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

describe("isPlanCredential", () => {
  it("covers subscription credentials, including a Codex access token and a Cursor user key", () => {
    expect(isPlanCredential({ harness: "claude-code", auth: "oauth-token" })).toBe(true);
    expect(isPlanCredential({ harness: "codex", auth: "chatgpt-login" })).toBe(true);
    expect(isPlanCredential({ harness: "codex", auth: "access-token" })).toBe(true);
    expect(isPlanCredential({ harness: "cursor-agent", auth: "api-key" })).toBe(true);
    expect(isPlanCredential({ harness: "cursor-agent", auth: "service-account" })).toBe(false);
    expect(isPlanCredential({ harness: "codex", auth: "api-key" })).toBe(false);
    expect(isPlanCredential({ harness: "claude-code", auth: "bedrock" })).toBe(false);
  });
});

describe("credentialConcurrency", () => {
  it("defaults to 1 for a ChatGPT sign-in, 2 for other plans and 16 for keys", () => {
    expect(credentialConcurrency({ harness: "codex", auth: "chatgpt-login" })).toBe(1);
    expect(credentialConcurrency({ harness: "claude-code", auth: "oauth-token" })).toBe(2);
    expect(credentialConcurrency({ harness: "cursor-agent", auth: "api-key" })).toBe(2);
    expect(credentialConcurrency({ harness: "codex", auth: "api-key" })).toBe(16);
    expect(credentialConcurrency({ harness: "cursor-agent", auth: "service-account" })).toBe(16);
  });

  it("takes the provider's concurrency", () => {
    const config = parseDeployConfig({
      ...minimal,
      providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token", concurrency: 1 }],
    });
    expect(credentialConcurrency(config.providers[0]!)).toBe(1);
  });

  it("refuses more than one task at once for a ChatGPT sign-in, or a limit out of range", () => {
    const codex = { id: "codex", harness: "codex", auth: "chatgpt-login" } as const;
    expect(issuesOf({ ...minimal, providers: [{ ...codex, concurrency: 2 }] })).toEqual([
      expect.objectContaining({ path: "providers[0].concurrency" }),
    ]);
    expect(
      parseDeployConfig({ ...minimal, providers: [{ ...codex, concurrency: 1 }] }),
    ).toBeTruthy();
    const key = { id: "k", harness: "codex", auth: "api-key" } as const;
    expect(issuesOf({ ...minimal, providers: [{ ...key, concurrency: 0 }] })).toHaveLength(1);
    expect(issuesOf({ ...minimal, providers: [{ ...key, concurrency: 65 }] })).toHaveLength(1);
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
