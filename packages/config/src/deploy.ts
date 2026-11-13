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

/** Auth methods that use a person's subscription. Setup asks for confirmation before storing these. */
export const PLAN_AUTH_METHODS: readonly AuthMethod[] = ["oauth-token", "chatgpt-login"];

export const ROLES = [
  "reviewer",
  "crossFile",
  "verifier",
  "replyJudge",
  "ticketExtractor",
] as const;
export type Role = (typeof ROLES)[number];

const TIERS = ["fast", "standard", "deep"] as const;

const providerSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/, "use lowercase letters, digits and hyphens (max 32)"),
    harness: z.enum(HARNESSES),
    auth: z.enum(AUTH_METHODS),
    models: z.partialRecord(z.enum(TIERS), z.string().min(1)).optional(),
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
    providers: z.array(providerSchema).min(1, "configure at least one model provider"),
    roles: z.partialRecord(z.enum(ROLES), z.string()).default({}),
    maxConcurrency: z.number().int().min(1).max(64).default(4),
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
