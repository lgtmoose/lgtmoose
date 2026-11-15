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

/** The most sandbox tasks one credential can be configured for at once. */
export const MAX_CREDENTIAL_CONCURRENCY = 64;

const providerSchema = z
  .object({
    id: z
      .string()
      .regex(PROVIDER_ID_PATTERN, "use lowercase letters, digits and hyphens (max 32)")
      .describe(
        "Your name for the provider. Its credential is stored as lgtmoose/provider/<id>, and roles refer to it.",
      ),
    harness: z
      .enum(HARNESSES)
      .describe("The agent that runs the review: claude-code, codex, cursor-agent or agent-sdk."),
    auth: z
      .enum(AUTH_METHODS)
      .describe("How the harness signs in. Each harness accepts only some methods."),
    /** Models per tier, overriding `DEFAULT_TIER_MODELS` for this provider's harness. */
    models: z
      .partialRecord(z.enum(TIERS), modelName)
      .optional()
      .describe(
        "Model per tier (fast, standard, deep). Tiers left out use the harness default: haiku, sonnet and opus for Claude Code and the Agent SDK, the CLI's own model for Codex and Cursor.",
      ),
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
          .default("global")
          .describe("CLOUD_ML_REGION: global, a multi-region (us, eu) or a region (us-east5)."),
        projectId: z
          .string()
          .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "use a Google Cloud project ID")
          .optional()
          .describe(
            "Google Cloud project. Defaults to the stored service-account key's project_id.",
          ),
      })
      .strict()
      .optional()
      .describe('Google Cloud settings, for auth: "vertex" only.'),
    /**
     * How many sandbox tasks may use this provider's credential at once, across every review
     * (`credentialConcurrency` has the defaults). A ChatGPT sign-in can only be 1.
     */
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_CREDENTIAL_CONCURRENCY)
      .optional()
      .describe("Sandbox tasks that may use this provider's credential at once, across reviews."),
  })
  .strict()
  .superRefine((provider, ctx) => {
    if (provider.auth === "chatgpt-login" && (provider.concurrency ?? 1) !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["concurrency"],
        message:
          "a ChatGPT sign-in runs one task at a time: a refresh rotates its tokens, so another task's copy would stop working",
      });
    }
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

/** GitHub's own domains (github.com, its API, raw content, assets, uploads and ghe.com). */
const GITHUB_DOMAINS = [
  "github.com",
  "githubusercontent.com",
  "githubassets.com",
  "githubapp.com",
  "ghe.com",
] as const;

/**
 * Whether a host is one of GitHub's, which `extraEgressHosts` refuses: the sandbox holds no
 * GitHub token, and an allowed GitHub host would let a steered model write to it with any token
 * it was given in the PR. A GitHub Enterprise Server on its own domain can't be told apart.
 */
export function isGitHubHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return GITHUB_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

export const deployConfigSchema = z
  .object({
    region: z
      .string()
      .regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, "use an AWS region such as us-east-1")
      .default("us-east-1")
      .describe("AWS region for every stack and secret."),
    profile: z
      .enum(["lean", "standard"])
      .default("lean")
      .describe(
        "lean: one NAT instance, RDS PostgreSQL on db.t4g.micro in one AZ, sandbox subnet and VPC endpoints in one AZ, one egress proxy task, short log retention. standard: a NAT gateway per AZ, RDS PostgreSQL on db.t4g.small with a Multi-AZ standby, two proxy tasks, longer retention and extra alarms. Switching is a redeploy that keeps the database; see docs/upgrading.md.",
      ),
    allowedOrgs: z
      .array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "use a GitHub org or user"))
      .min(1, "list at least one GitHub org or user")
      .describe("GitHub orgs or users whose repositories LGTMoose reviews. Others are ignored."),
    /**
     * Model providers, in fallback order: when a run hits a provider's rate or plan limit, it
     * moves to the next one.
     */
    providers: z
      .array(providerSchema)
      .min(1, "configure at least one model provider")
      .describe(
        "Model providers in fallback order: a rate limit, a used-up plan or a rejected credential moves a run to the next one.",
      ),
    /**
     * Which provider each role starts on. The rest of `providers` follow in order as fallbacks.
     * A role left out starts on the first provider.
     */
    roles: z
      .partialRecord(z.enum(ROLES), z.string())
      .default({})
      .describe(
        "The provider id each role starts on. A role left out starts on the first provider; the others follow as fallbacks.",
      ),
    maxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(64)
      .default(4)
      .describe(
        "Most review batches of one PR run at once. Lower when the reviewer credential's concurrency is lower.",
      ),
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
     * Feedback signals (NIC-841): the reconciler reads 👍/👎 on LGTMoose's inline comments and
     * works out, per rule category, how often findings are accepted. Signals only: nothing
     * changes on its own. A category below the threshold is flagged for a person to look at.
     */
    feedback: z
      .object({
        acceptanceThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe("Acceptance below which a rule category is flagged for a person to look at."),
        minSamples: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .default(10)
          .describe("Accepted plus rejected findings a category needs before it's judged."),
        maxCommentsPerRun: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .default(100)
          .describe(
            "Most inline comments whose reactions one reconciler run reads (one GitHub call each). 0 stops reading them.",
          ),
      })
      .strict()
      .default({ acceptanceThreshold: 0.5, minSamples: 10, maxCommentsPerRun: 100 })
      .describe(
        "Feedback signals: how often findings are accepted per rule category, from fixes, declines and 👍/👎. Signals only; see docs/feedback.md.",
      ),
    /**
     * Where CloudWatch alarms notify. Without either, alarms still change state in CloudWatch but
     * nobody is told. Never hardcoded: set it here.
     */
    alarms: z
      .object({
        email: z
          .email()
          .optional()
          .describe(
            "An address subscribed to a new SNS topic for LGTMoose's alarms. AWS emails it a confirmation link first.",
          ),
        topicArn: z
          .string()
          .regex(
            /^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/,
            "use an SNS topic ARN",
          )
          .optional()
          .describe("An existing SNS topic for alarms, such as one that already pages your team."),
      })
      .strict()
      .refine((alarms) => alarms.email === undefined || alarms.topicArn === undefined, {
        message: "set email or topicArn, not both",
      })
      .default({})
      .describe(
        "Where alarms notify: an email address (a new SNS topic) or an existing SNS topic. Without either, alarms only change state in CloudWatch.",
      ),
    /**
     * The most replies on LGTMoose's findings the reply judge reads in one run (a fast-tier
     * model call each). Replies past it wait for the next run.
     */
    maxReplyJudgements: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(10)
      .describe(
        "Most replies on LGTMoose's findings judged per run (one fast-tier model call each). 0 turns the reply judge off.",
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
      .array(
        hostname.refine(
          (host) => !isGitHubHost(host),
          "GitHub's hosts can't be allowed: the model sandbox must never reach GitHub",
        ),
      )
      .default([])
      .describe(
        "Extra hosts sandbox tasks may reach through the egress proxy, on top of the providers' model APIs. Exact hostnames only.",
      ),
    /**
     * Learnings retrieval. `embeddings` ranks a batch's learnings by similarity to its diff:
     * `bedrock` (Titan Text Embeddings in this account), `openai` (its embeddings API, with the
     * key stored in `SECRET_NAMES.openAiEmbeddings`), or `none` to rank by keywords with no
     * network call. Bedrock and OpenAI receive learning text and batch diffs.
     */
    learnings: z
      .object({
        embeddings: z
          .discriminatedUnion("provider", [
            z.object({ provider: z.literal("none") }).strict(),
            z
              .object({
                provider: z.literal("bedrock"),
                model: z
                  .string()
                  .regex(
                    /^amazon\.titan-embed-text-v2(?::\d+)?$/,
                    "use a Titan Text Embeddings v2 model ID",
                  )
                  .default("amazon.titan-embed-text-v2:0"),
              })
              .strict(),
            z
              .object({
                provider: z.literal("openai"),
                model: z
                  .string()
                  .regex(
                    /^text-embedding-3-(?:small|large)$/,
                    "use text-embedding-3-small or -large",
                  )
                  .default("text-embedding-3-small"),
              })
              .strict(),
          ])
          .default({ provider: "none" })
          .describe(
            "How learnings are ranked against a batch's diff: bedrock or openai embeddings, or none for keywords. The provider receives learning text and diffs.",
          ),
      })
      .strict()
      .default({ embeddings: { provider: "none" } })
      .describe("Learnings retrieval: how the learnings for each review batch are ranked."),
    /**
     * Ticket coverage (NIC-839): the review reads the tickets a PR names (in its branch, title,
     * description and commits) and checks the PR against their requirements. Only Linear is
     * built; its API key is stored by `lgtmoose auth linear` and read by the control task only.
     * Only PRs by the repository's owners, members and collaborators get tickets read, and a
     * public repository's summary shows no ticket text unless `detailsOnPublicRepos` is on.
     */
    tickets: z
      .object({
        provider: z
          .enum(["linear", "jira", "github-issues"])
          .refine((provider) => provider === "linear", "only linear is built so far")
          .describe("The ticket system: linear. jira and github-issues aren't built yet."),
        maxPerPullRequest: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe(
            "The most tickets checked per pull request, in the order they're named. Each costs one fast-tier model run per commit reviewed.",
          ),
        teamKeys: z
          .array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/, "a team key, such as ENG"))
          .default([])
          .describe(
            "Only these teams' ticket keys count, such as ENG for ENG-123. Empty: any key the provider knows.",
          ),
        detailsOnPublicRepos: z
          .boolean()
          .default(false)
          .describe(
            "Show tickets' titles, links and requirements in the summary on public repositories too. Off: a public repository's summary shows only each key, its coverage level and how many core requirements look missing.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Ticket coverage: check each PR against the tickets it names. Left out: off. The provider receives no code; the model checks coverage in the sandbox.",
      ),
    dashboard: z
      .boolean()
      .default(true)
      .describe("Reserved for the dashboard. Not used yet: no dashboard is deployed."),
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

/**
 * How many sandbox tasks may use a provider's credential at once: its `concurrency`, or a
 * default.
 * - A ChatGPT sign-in is always 1. Codex refreshes its tokens during a run, and the refresh
 *   retires the old refresh token. So one task holds it at a time, and only that task's
 *   refreshed `auth.json` is stored.
 * - Other plan credentials default to 2, since plans throttle or flag heavy parallel use.
 * - API keys and service accounts default to 16.
 */
export function credentialConcurrency(
  provider: Pick<ProviderConfig, "harness" | "auth" | "concurrency">,
): number {
  if (provider.auth === "chatgpt-login") return 1;
  if (provider.concurrency !== undefined) return provider.concurrency;
  return isPlanCredential(provider) ? 2 : 16;
}

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
