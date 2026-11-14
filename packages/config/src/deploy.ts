import { z } from "zod";
import { toConfigError } from "./errors.js";

/** Which auth methods each harness accepts. Mirrors the providers table in docs/architecture.md. */
export const HARNESS_AUTH = {
  "claude-code": ["oauth-token", "api-key", "bedrock", "vertex"],
  codex: ["chatgpt-login", "access-token", "api-key"],
  "cursor-agent": ["api-key", "service-account"],
  "agent-sdk": ["api-key", "bedrock", "vertex"],
} as const;

export type Harness = keyof typeof HARNESS_AUTH;
export type AuthMethod = (typeof HARNESS_AUTH)[Harness][number];

const HARNESSES = Object.keys(HARNESS_AUTH) as [Harness, ...Harness[]];
const AUTH_METHODS = [...new Set(Object.values(HARNESS_AUTH).flat())] as [
  AuthMethod,
  ...AuthMethod[],
];

/**
 * Auth methods that use a person's subscription, so `lgtmoose auth` asks for confirmation
 * before storing them. A Codex access token is a ChatGPT plan's token: it signs in through
 * chatgpt.com, like a ChatGPT sign-in.
 */
export const PLAN_AUTH_METHODS: readonly AuthMethod[] = [
  "oauth-token",
  "chatgpt-login",
  "access-token",
];

/**
 * Whether a provider's credential belongs to a person's subscription plan: a plan auth method,
 * or a Cursor user API key, which bills to that user's Cursor plan. A Cursor service-account
 * key belongs to the team.
 */
export function isPlanCredential(provider: { harness: Harness; auth: AuthMethod }): boolean {
  return (
    PLAN_AUTH_METHODS.includes(provider.auth) ||
    (provider.harness === "cursor-agent" && provider.auth === "api-key")
  );
}

/** What a provider `id` may look like. Also the last part of its secret's name. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export const ROLES = [
  "reviewer",
  "crossFile",
  "verifier",
  "replyJudge",
  "ticketExtractor",
] as const;
export type Role = (typeof ROLES)[number];

/** Model tiers: cheap and quick, the default, and the strongest. */
export const TIERS = ["fast", "standard", "deep"] as const;
export type Tier = (typeof TIERS)[number];

/** A model name or alias as the CLIs take it, e.g. `sonnet`, `claude-opus-5-5`, `gpt-5-codex`. */
const modelName = z
  .string()
  .regex(/^[\w.:@/[\]-]{1,128}$/, "use a model name or alias, without spaces or quotes");

/**
 * Models per tier when a provider's `models` leaves a tier out. Claude Code and the Agent SDK
 * take aliases that follow the newest model of each family, also on Bedrock and Vertex. Codex
 * and Cursor are left to their CLI's own default model: Codex maps the tier to a reasoning
 * effort instead (see the harness).
 */
export const DEFAULT_TIER_MODELS: Readonly<
  Record<Harness, Readonly<Partial<Record<Tier, string>>>>
> = {
  "claude-code": { fast: "haiku", standard: "sonnet", deep: "opus" },
  "agent-sdk": { fast: "haiku", standard: "sonnet", deep: "opus" },
  codex: {},
  "cursor-agent": {},
};

const providerSchema = z
  .object({
    id: z.string().regex(PROVIDER_ID_PATTERN, "use lowercase letters, digits and hyphens (max 32)"),
    harness: z.enum(HARNESSES),
    auth: z.enum(AUTH_METHODS),
    /** Models per tier, overriding `DEFAULT_TIER_MODELS` for this provider's harness. */
    models: z.partialRecord(z.enum(TIERS), modelName).optional(),
    /**
     * Google Cloud settings for `vertex` auth. The service-account key itself is the stored
     * credential (`lgtmoose auth`); its `project_id` is used when `projectId` is left out.
     */
    vertex: z
      .object({
        /** CLOUD_ML_REGION: `global`, a multi-region (`us`, `eu`) or a region (`us-east5`). */
        region: z
          .string()
          .regex(
            /^(global|us|eu|[a-z]+-[a-z]+\d+)$/,
            "use global, us, eu or a region like us-east5",
          )
          .default("global"),
        projectId: z
          .string()
          .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "use a Google Cloud project ID")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((provider, ctx) => {
    const allowed: readonly string[] = HARNESS_AUTH[provider.harness];
    if (!allowed.includes(provider.auth)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth"],
        message: `${provider.harness} doesn't support "${provider.auth}". Use one of: ${allowed.join(", ")}`,
      });
    }
    if (provider.vertex !== undefined && provider.auth !== "vertex") {
      ctx.addIssue({
        code: "custom",
        path: ["vertex"],
        message: 'vertex settings apply only to auth: "vertex"',
      });
    }
  });

const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
    "use an exact lowercase hostname, without scheme, port or wildcard",
  );

export const deployConfigSchema = z
  .object({
    region: z
      .string()
      .regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, "use an AWS region such as us-east-1")
      .default("us-east-1"),
    profile: z.enum(["lean", "standard"]).default("lean"),
    allowedOrgs: z
      .array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "use a GitHub org or user"))
      .min(1, "list at least one GitHub org or user"),
    /**
     * Model providers, in fallback order: when a run hits a provider's rate or plan limit, it
     * moves to the next one.
     */
    providers: z.array(providerSchema).min(1, "configure at least one model provider"),
    /**
     * Which provider each role starts on. The rest of `providers` follow in order as fallbacks.
     * A role left out starts on the first provider.
     */
    roles: z.partialRecord(z.enum(ROLES), z.string()).default({}),
    maxConcurrency: z.number().int().min(1).max(64).default(4),
    /**
     * How often the reconciler compares open PRs with what the database recorded, catching
     * missed webhooks and drifted status labels. It makes no model calls.
     */
    reconcileIntervalMinutes: z
      .number()
      .int()
      .min(5)
      .max(1440)
      .default(30)
      .describe(
        "Minutes between reconciler runs, which catch missed webhooks and drifted status labels.",
      ),
    /**
     * How far back the reconciler looks for missed webhooks: it queues a review only for a PR
     * updated within this many hours, so a first run (or a newly added repository) doesn't
     * review every old open PR. At least the interval.
     */
    reconcileLookbackHours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(24)
      .describe(
        "Hours back the reconciler queues reviews for: only PRs updated within this window. At least the interval.",
      ),
    /**
     * Shadow mode: the review workflow records what it would post (the review, check run,
     * summary comment and labels) to the artifact bucket and the log instead of posting it to
     * GitHub. On by default until reviews have been checked on real PRs (M1).
     */
    shadow: z
      .boolean()
      .default(true)
      .describe(
        "Record reviews to the artifact bucket and the log instead of posting them to GitHub.",
      ),
    /**
     * Hosts sandbox tasks may reach through the egress proxy on top of the enabled providers'
     * model APIs (see `egressAllowlist`), such as a regional Vertex AI endpoint or a model
     * gateway. Exact hostnames only; everything else, GitHub included, is refused.
     */
    extraEgressHosts: z
      .array(hostname)
      .default([])
      .describe(
        "Extra hosts sandbox tasks may reach through the egress proxy, on top of the providers' model APIs. Exact hostnames only.",
      ),
    tickets: z
      .object({ provider: z.enum(["linear", "jira", "github-issues"]) })
      .strict()
      .optional(),
    dashboard: z.boolean().default(true),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.reconcileLookbackHours * 60 < config.reconcileIntervalMinutes) {
      ctx.addIssue({
        code: "custom",
        path: ["reconcileLookbackHours"],
        message:
          "must cover at least reconcileIntervalMinutes, or webhooks missed between runs are never caught",
      });
    }
    const seen = new Set<string>();
    config.providers.forEach((provider, index) => {
      if (seen.has(provider.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "id"],
          message: `duplicate provider id "${provider.id}"`,
        });
      }
      seen.add(provider.id);
    });
    for (const [role, providerId] of Object.entries(config.roles)) {
      if (providerId !== undefined && !seen.has(providerId)) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", role],
          message: `no provider with id "${providerId}". Known ids: ${[...seen].join(", ")}`,
        });
      }
    }
  });

/** What a person writes in lgtmoose.config.ts. Optional keys get defaults. */
export type DeployConfigInput = z.input<typeof deployConfigSchema>;
/** The validated config with every default filled in. */
export type DeployConfig = z.output<typeof deployConfigSchema>;
export type ProviderConfig = DeployConfig["providers"][number];

/** Typed helper for lgtmoose.config.ts. It returns its argument; validation happens at load time. */
export function defineConfig(config: DeployConfigInput): DeployConfigInput {
  return config;
}

/** Validates a deploy config and fills defaults. Throws ConfigError naming each bad key. */
export function parseDeployConfig(input: unknown, source = "lgtmoose.config.ts"): DeployConfig {
  const result = deployConfigSchema.safeParse(input);
  if (!result.success) throw toConfigError(source, result.error);
  return result.data;
}

/** The provider each role uses. Roles without an assignment use the first provider. */
export function resolveRoles(config: DeployConfig): Record<Role, ProviderConfig> {
  const byId = new Map(config.providers.map((provider) => [provider.id, provider]));
  const [first] = config.providers;
  if (first === undefined) throw new Error("config has no providers");
  return Object.fromEntries(
    ROLES.map((role) => {
      const id = config.roles[role];
      return [role, (id === undefined ? undefined : byId.get(id)) ?? first];
    }),
  ) as Record<Role, ProviderConfig>;
}

/** The model a provider uses for a tier: its own `models`, else the harness default. */
export function modelFor(provider: ProviderConfig, tier: Tier): string | undefined {
  return provider.models?.[tier] ?? DEFAULT_TIER_MODELS[provider.harness][tier];
}

/**
 * The providers a role tries, in order: the one `roles` assigns (or the first provider), then
 * every other provider in config order, as fallbacks for rate and plan limits.
 */
export function providerChain(config: DeployConfig, role: Role): ProviderConfig[] {
  const first = resolveRoles(config)[role];
  return [first, ...config.providers.filter((provider) => provider.id !== first.id)];
}
