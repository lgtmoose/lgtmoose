<!-- Generated from packages/config by `pnpm --filter @lgtmoose/config docs`. Don't edit by hand. -->

# Configuration reference

LGTMoose has two config files. Both are checked with zod when they're read, and a bad key fails with its path. The JSON Schemas in `packages/config/schema/` give editors autocompletion.

## `lgtmoose.config.ts`: the deployment

One per install, in your checkout. `lgtmoose setup` writes it; `lgtmoose deploy` reads it. Export the config through `defineConfig` from `@lgtmoose/config`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `region` | string matching `^[a-z]{2}(-gov)?-[a-z]+-\d$` | `"us-east-1"` | AWS region for every stack and secret. |
| `profile` | `"lean"` or `"standard"` | `"lean"` | lean: one NAT instance, RDS PostgreSQL on db.t4g.micro in one AZ, sandbox subnet and VPC endpoints in one AZ, one egress proxy task, short log retention. standard: a NAT gateway per AZ, RDS PostgreSQL on db.t4g.small with a Multi-AZ standby, two proxy tasks, longer retention and extra alarms. Switching is a redeploy that keeps the database; see docs/upgrading.md. |
| `allowedOrgs` (required) | list of string matching `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`, at least 1 |  | GitHub orgs or users whose repositories LGTMoose reviews. Others are ignored. |
| `providers` (required) | list of object, at least 1 |  | Model providers in fallback order: a rate limit, a used-up plan or a rejected credential moves a run to the next one. |
| `providers[].id` (required) | string matching `^[a-z][a-z0-9-]{0,31}$` |  | Your name for the provider. Its credential is stored as lgtmoose/provider/&lt;id&gt;, and roles refer to it. |
| `providers[].harness` (required) | `"claude-code"` or `"codex"` or `"cursor-agent"` or `"agent-sdk"` |  | The agent that runs the review: claude-code, codex, cursor-agent or agent-sdk. |
| `providers[].auth` (required) | `"oauth-token"` or `"api-key"` or `"bedrock"` or `"vertex"` or `"chatgpt-login"` or `"access-token"` or `"service-account"` |  | How the harness signs in. Each harness accepts only some methods. |
| `providers[].models` | map of `"fast"` or `"standard"` or `"deep"` to string matching `^[\w.:@/[\]-]{1,128}$` |  | Model per tier (fast, standard, deep). Tiers left out use the harness default: haiku, sonnet and opus for Claude Code and the Agent SDK, the CLI's own model for Codex and Cursor. |
| `providers[].vertex` | object |  | Google Cloud settings, for auth: "vertex" only. |
| `providers[].vertex.region` | string matching <code>^(global&#124;us&#124;eu&#124;[a-z]+-[a-z]+\d+)$</code> | `"global"` | CLOUD_ML_REGION: global, a multi-region (us, eu) or a region (us-east5). |
| `providers[].vertex.projectId` | string matching `^[a-z][a-z0-9-]{4,28}[a-z0-9]$` |  | Google Cloud project. Defaults to the stored service-account key's project_id. |
| `providers[].concurrency` | integer, 1 to 64 |  | Sandbox tasks that may use this provider's credential at once, across reviews. |
| `roles` | map of `"reviewer"` or `"crossFile"` or `"verifier"` or `"replyJudge"` or `"ticketExtractor"` to string | `{}` | The provider id each role starts on. A role left out starts on the first provider; the others follow as fallbacks. |
| `maxConcurrency` | integer, 1 to 64 | `4` | Most review batches of one PR run at once. Lower when the reviewer credential's concurrency is lower. |
| `reconcileIntervalMinutes` | integer, 5 to 1440 | `30` | Minutes between reconciler runs, which catch missed webhooks and drifted status labels. |
| `reconcileLookbackHours` | integer, 1 to 720 | `24` | Hours back the reconciler queues reviews for: only PRs updated within this window. At least the interval. |
| `feedback` | object | `{"acceptanceThreshold":0.5,"minSamples":10,"maxCommentsPerRun":100}` | Feedback signals: how often findings are accepted per rule category, from fixes, declines and 👍/👎. Signals only; see docs/feedback.md. |
| `feedback.acceptanceThreshold` | number, 0 to 1 | `0.5` | Acceptance below which a rule category is flagged for a person to look at. |
| `feedback.minSamples` | integer, 1 to 10000 | `10` | Accepted plus rejected findings a category needs before it's judged. |
| `feedback.maxCommentsPerRun` | integer, 0 to 1000 | `100` | Most inline comments whose reactions one reconciler run reads (one GitHub call each). 0 stops reading them. |
| `alarms` | object | `{}` | Where alarms notify: an email address (a new SNS topic) or an existing SNS topic. Without either, alarms only change state in CloudWatch. |
| `alarms.email` | string matching `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |  | An address subscribed to a new SNS topic for LGTMoose's alarms. AWS emails it a confirmation link first. |
| `alarms.topicArn` | string matching `^arn:aws[a-z-]*:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$` |  | An existing SNS topic for alarms, such as one that already pages your team. |
| `maxReplyJudgements` | integer, 0 to 50 | `10` | Most replies on LGTMoose's findings judged per run (one fast-tier model call each). 0 turns the reply judge off. |
| `shadow` | boolean | `true` | Record reviews to the artifact bucket and the log instead of posting them to GitHub. |
| `extraEgressHosts` | list of string matching `^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$` | `[]` | Extra hosts sandbox tasks may reach through the egress proxy, on top of the providers' model APIs. Exact hostnames only. |
| `learnings` | object | `{"embeddings":{"provider":"none"}}` | Learnings retrieval: how the learnings for each review batch are ranked. |
| `learnings.embeddings` | one of the forms below | `{"provider":"none"}` | How learnings are ranked against a batch's diff: bedrock or openai embeddings, or none for keywords. The provider receives learning text and diffs. |
| `learnings.embeddings.provider` (required) | `"none"` or `"bedrock"` or `"openai"` |  | Which form this is. |
| `learnings.embeddings.model` | string matching `^amazon\.titan-embed-text-v2(?::\d+)?$` | `"amazon.titan-embed-text-v2:0"` | With `provider: "bedrock"`. |
| `learnings.embeddings.model` | string matching <code>^text-embedding-3-(?:small&#124;large)$</code> | `"text-embedding-3-small"` | With `provider: "openai"`. |
| `tickets` | object |  | Ticket coverage: check each PR against the tickets it names. Left out: off. The provider receives no code; the model checks coverage in the sandbox. |
| `tickets.provider` | `"linear"` or `"jira"` or `"github-issues"` |  | The ticket system: linear. jira and github-issues aren't built yet. |
| `tickets.maxPerPullRequest` | integer, 1 to 10 | `3` | The most tickets checked per pull request, in the order they're named. Each costs one fast-tier model run per commit reviewed. |
| `tickets.teamKeys` | list of string matching `^[A-Za-z][A-Za-z0-9]{0,9}$` | `[]` | Only these teams' ticket keys count, such as ENG for ENG-123. Empty: any key the provider knows. |
| `dashboard` | boolean | `true` | Reserved for the dashboard. Not used yet: no dashboard is deployed. |

Each harness accepts only some `auth` methods: `claude-code` takes `oauth-token`, `api-key`, `bedrock` and `vertex`; `codex` takes `chatgpt-login`, `access-token` and `api-key`; `cursor-agent` takes `api-key` and `service-account`; `agent-sdk` takes `api-key`, `bedrock` and `vertex`. See [Providers and auth](credentials.md).

## `.lgtmoose.yaml`: per repository

Optional, at the repository's root. It's read from the PR's base branch, never from the PR itself, so a PR can't change how it's reviewed. A missing or empty file gives the defaults.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `rulepacks` | list of string | `["generic"]` | Rule packs to review with: built-in or private pack ids, and ./rules/&lt;name&gt;.md or ./rules/*.md from this repository. generic and security are always on. |
| `conventions` | list of string | `["CLAUDE.md","AGENTS.md",".github/copilot-instructions.md",".cursor/rules/*.mdc"]` | Files of team conventions the reviewer reads, as globs. |
| `tiers` | map of string matching `^[1-7]$` to list of string | `{}` | Risk tiers, most important first: keys 1 to 7, each a list of globs. Files are reviewed in tier order; tests go last. |
| `skip` | list of string | `[]` | Globs never to review, on top of the defaults (lockfiles, build output, vendored, generated and binary files). They win over include. |
| `include` | list of string | `[]` | Globs to review even though a default skip matches them. skip still wins, and binaries are always skipped. |
| `registries` | list of string matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$` | `[]` | Extra package hosts to trust in lockfiles, such as a private registry. |
| `gate` | object | `{}` | How a review's decision is posted. |
| `gate.check_run` | `"required"` or `"optional"` or `"off"` | `"required"` | The LGTMoose check run. required: it fails on open blocking findings. optional: failing and held results are posted as neutral. off: no check run. |
| `gate.approve` | boolean | `true` | false: a clean review posts COMMENT instead of APPROVE. |
| `gate.nit_cap` | integer, 0 to 100 | `10` | Most nits posted in one review. The rest are counted in the summary. |
| `injection` | object | `{}` | The prompt-injection detector. |
| `injection.allow` | list of string | `[]` | Globs whose added lines the prompt-injection detector doesn't scan, such as its own tests. Keep them narrow. |
| `labels` | object | `{}` | The three status labels LGTMoose keeps on a PR: pending, changes and approved. |
| `labels.pending` | string | `"Ready for Review"` | Set when a review holds for a person: it was incomplete, or flagged a prompt-injection attempt. |
| `labels.changes` | string | `"Requires Changes"` | Set when blocking or should-fix findings are open. |
| `labels.approved` | string | `"Approved"` | Set when no blocking or should-fix finding is open, also with gate.approve: false. |
