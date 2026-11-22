import { z } from "zod";
import { budgetsSchema } from "./budgets.js";
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

/**
 * A GitHub login: letters, digits and single hyphens, not at either end, at most 39 characters.
 * Written without `|` or `](`, so the configuration reference shows it as a plain code span.
 */
export const GITHUB_LOGIN = /^(?!-)(?!.*--)(?!.*-$)[A-Za-z0-9-]{1,39}$/;

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
     * A cap on thinking tokens per tier. Claude Code reads it as `MAX_THINKING_TOKENS` and
     * raises anything under 1024 to 1024, its minimum budget. Unset keeps the model's own
     * thinking. Codex and Cursor ignore it.
     */
    thinkingTokens: z
      .partialRecord(z.enum(TIERS), z.number().int().min(1024).max(128_000))
      .optional()
      .describe(
        "Cap on thinking tokens per tier (fast, standard, deep), at least 1024. Tiers left out keep the model's own thinking. Claude Code and the Agent SDK honor it; Codex and Cursor ignore it.",
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

/** The images a release publishes, by their key in `images.digests`. */
export const RELEASE_IMAGES = {
  control: "lgtmoose-control",
  sandbox: "lgtmoose-sandbox",
  egressProxy: "lgtmoose-egress-proxy",
} as const;

const imageDigest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "use an image digest, sha256: and 64 hex characters");

/**
 * Where the task images come from. `build` builds them from this checkout, as before. `release`
 * uses a published release's images (docs/releasing.md), pinned by digest, never by tag: a tag
 * can be moved, a digest can't. CDK copies them into the deployment's own ECR, so tasks never
 * pull from the internet.
 */
export const imagesSchema = z
  .discriminatedUnion("source", [
    z
      .object({
        source: z.literal("build").describe("Build the images from this checkout, with Docker."),
      })
      .strict(),
    z
      .object({
        source: z
          .literal("release")
          .describe("Use a published release's images, copied into this deployment's ECR."),
        registry: z
          .string()
          .regex(
            /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/,
            "use a registry and namespace, such as ghcr.io/lgtmoose",
          )
          .default("ghcr.io/lgtmoose")
          .describe("Where the release's images are published."),
        version: z
          .string()
          .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "use a release version, such as 0.1.0")
          .describe("The release, such as 0.1.0. It's for the record: the digests decide."),
        digests: z
          .object({
            control: imageDigest.describe("The lgtmoose-control image's digest."),
            sandbox: imageDigest.describe("The lgtmoose-sandbox image's digest."),
            egressProxy: imageDigest.describe("The lgtmoose-egress-proxy image's digest."),
          })
          .strict()
          .describe(
            "Each image's digest, from the release notes. Verify them first (docs/releasing.md).",
          ),
      })
      .strict(),
  ])
  .default({ source: "build" })
  .describe(
    "Where the control, egress proxy and sandbox images come from: build (from this checkout, the default) or release (a published release, pinned by digest).",
  );

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
     * How long batches after the first wait before they start. The first batch writes the
     * shared prompt into the cache; the rest then read it instead of writing it again. 0
     * starts every batch at once.
     */
    batchStaggerSeconds: z
      .number()
      .int()
      .min(0)
      .max(120)
      .default(30)
      .describe(
        "Seconds batches after the first wait before starting, so they read the first batch's prompt cache. 0 starts every batch at once.",
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
          .default(3)
          .describe(
            "Accepted plus rejected findings a category needs before it's judged. Acceptance is smoothed with a prior, so a small number doesn't flap.",
          ),
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
      .default({ acceptanceThreshold: 0.5, minSamples: 3, maxCommentsPerRun: 100 })
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
     * Where the control, egress proxy and sandbox images come from: built from this checkout (the
     * default), or a published release's images, pinned by digest (docs/releasing.md).
     */
    images: imagesSchema,
    /**
     * Spend caps (NIC-1079): the most estimated model cost per PR per day, per repository per
     * month and for the deployment per month, and the price table the estimate uses. Unset, no
     * cap applies. A repository's `.lgtmoose.yaml` can only lower its own.
     */
    budgets: budgetsSchema,
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
     * The most `@lgtmoose explain` requests answered by the explainer in one run of a PR (a
     * fast-tier model call each, at most one per finding per head). Requests past it wait for
     * the next run.
     */
    maxExplanations: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(5)
      .describe(
        "Most `@lgtmoose explain` requests a model answers per PR per run (one fast-tier model call each, at most one per finding per commit). 0 keeps the stored-finding reply.",
      ),
    /**
     * Other handles that `@`-commands may use besides the App's own (NIC-1119). An App made with
     * `lgtmoose setup` is often called `lgtmoose-<org>`, while the docs say `@lgtmoose`. Add
     * `lgtmoose` here so `@lgtmoose review` works too. A handle never changes what a command may
     * do: that depends on who wrote it. GitHub also notifies whoever owns an alias's login.
     */
    commandAliases: z
      .array(
        z
          .string()
          // A regex, not a refine, so the JSON schema keeps the pattern and editors flag `@lgtmoose`.
          .regex(
            GITHUB_LOGIN,
            "aliases are GitHub logins: letters, digits and single hyphens, at most 39 characters",
          )
          .describe("A GitHub login: letters, digits and single hyphens, at most 39 characters."),
      )
      .max(5)
      .default([])
      .describe(
        "Other handles @-commands may use besides the App's own, such as lgtmoose when the App is lgtmoose-<org>. Up to 5 GitHub logins.",
      ),
    /**
     * Whether a comment that mentions `@lgtmoose` followed by a whole command, where the App is called
     * something else and `lgtmoose` isn't an alias, gets one reply per PR naming the handle that
     * works (NIC-1119). It assumes no other App called `lgtmoose` answers on these repositories;
     * turn it off if one does.
     */
    commandHint: z
      .boolean()
      .default(true)
      .describe(
        "Reply once per PR when a comment mentions @lgtmoose followed by a whole command where the App is called something else. Turn off if another App called lgtmoose answers on these repositories.",
      ),
    /**
     * How long a push's review waits for the next push before it starts (NIC-1077): a newer
     * push in that time stops it before it clones. The dispatcher reads it; it holds no GitHub
     * credential, so this is a deployment setting, not a repo one.
     */
    reviewDebounceSeconds: z
      .number()
      .int()
      .min(0)
      .max(1800)
      .default(60)
      .describe(
        "Seconds a push's review waits for the next push before it starts. A newer push in that time replaces it.",
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
        maxPendingPerAuthor: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(5)
          .describe(
            "The most pending learnings one author without write access may have in an org. A new learn: past it is refused and nothing is stored.",
          ),
        bootstrapMaxCostUsd: z
          .number()
          .min(0)
          .max(1000)
          .default(5)
          .describe(
            "The most estimated model cost, in USD, of one bootstrap from a repository's review history (lgtmoose learnings bootstrap). A request can ask for less, never more.",
          ),
        /**
         * On how many PRs of a repo findings about the same thing must be declined, disputed or
         * 👎'd before LGTMoose proposes a learning not to raise it (NIC-1081).
         */
        repeatThreshold: z
          .number()
          .int()
          .min(2)
          .max(20)
          .default(2)
          .describe(
            "On how many PRs of a repository findings about the same thing must be declined, disputed or 👎'd before LGTMoose proposes a learning not to raise it. Never for protected categories.",
          ),
      })
      .strict()
      .default({
        embeddings: { provider: "none" },
        maxPendingPerAuthor: 5,
        repeatThreshold: 2,
        bootstrapMaxCostUsd: 5,
      })
      .describe(
        "Learnings: how the learnings for each review batch are ranked, how many pending learnings one author may have, and when repeated rejections make one.",
      ),
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
      .describe(
        "Deploy the dashboard (Lgtmoose-Dashboard): a CloudFront site where members of allowedOrgs sign in with GitHub and see open findings and review runs for the repositories they can see. false: no dashboard stack.",
      ),
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
      // A release's sandbox image is built without the Cursor CLI (see docs/releasing.md).
      if (config.images.source === "release" && provider.harness === "cursor-agent") {
        ctx.addIssue({
          code: "custom",
          path: ["providers", index, "harness"],
          message:
            'a release\'s sandbox image has no Cursor CLI: use images: { source: "build" } for cursor-agent',
        });
      }
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
