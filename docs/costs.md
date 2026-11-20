# Costs

LGTMoose runs in your AWS account, so you pay AWS for what it deploys, and your model vendors for what the reviews use. There's no LGTMoose service to pay for. This page lists what costs money, an estimate for each profile, and what you can change.

## Always on

These run whether or not anyone opens a PR. `profile` in `lgtmoose.config.ts` picks the size:

| Part                                                                 | `lean` (default)                                     | `standard`                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| Database                                                             | RDS PostgreSQL on `db.t4g.micro`, one AZ, 20 GiB gp3 | RDS PostgreSQL on `db.t4g.small` with a Multi-AZ standby, 20 GiB gp3 |
| NAT for the app subnets                                              | one `t4g.micro` NAT instance                         | a NAT gateway in each of two AZs                                     |
| Egress proxy (Fargate, ARM64, 0.25 vCPU, 512 MiB)                    | one task                                             | two tasks                                                            |
| Interface VPC endpoints (ECR API, ECR Docker, Secrets Manager, Logs) | 4, in one AZ                                         | 4 in each of two AZs: 8                                              |
| Log retention                                                        | a week (the credential audit log: 3 months)          | a month (the credential audit log: a year)                           |
| Alarms                                                               | dead-letter queues and credentials                   | those, plus database CPU, free storage and failed reviews            |

Also always there, but small: Secrets Manager secrets (one for the GitHub App, one for the webhook secret, the database's, and one per stored provider credential), the S3 artifact bucket, and CloudWatch logs.

Both profiles span two AZs, because an RDS subnet group needs two; `lean` puts its NAT, sandbox subnet and endpoints in one of them. `lean` is meant for one team. `standard` is for when the database, NAT and proxy shouldn't depend on one AZ.

## Monthly estimate

**An estimate, not a quote.** It uses AWS's on-demand list prices for **us-east-1**, read from the AWS Price List API in November 2026 (offers published 4 to 13 November 2026), for 730 hours a month, with no free tier and no savings plans. Prices differ by region and change over time: put the figures into the [AWS Pricing Calculator](https://calculator.aws/) for your region before relying on them.

| Line                                                       | `lean`                                     | `standard`                                |
| ---------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| NAT                                                        | t4g.micro at $0.0084/h: $6.13              | 2 NAT gateways at $0.045/h: $65.70        |
| NAT public IPv4 ($0.005/h each)                            | 1: $3.65                                   | 2: $7.30                                  |
| NAT instance disk (8 GiB gp3 at $0.08/GB-mo)               | $0.64                                      | none                                      |
| Interface endpoints ($0.01/h each per AZ)                  | 4: $29.20                                  | 8: $58.40                                 |
| Database instance                                          | db.t4g.micro single-AZ at $0.016/h: $11.68 | db.t4g.small Multi-AZ at $0.065/h: $47.45 |
| Database storage (20 GiB gp3)                              | $0.115/GB-mo: $2.30                        | Multi-AZ, $0.23/GB-mo: $4.60              |
| Egress proxy (Fargate ARM: $0.03238/vCPU-h, $0.00356/GB-h) | 1 task: $7.21                              | 2 tasks: $14.42                           |
| Secrets Manager ($0.40 each; 4 with one stored provider)   | $1.60                                      | $1.60                                     |
| CloudWatch alarms ($0.10 each, one stored provider)        | 3: $0.30                                   | 6: $0.60                                  |
| **Fixed total**                                            | **about $63 a month**                      | **about $200 a month**                    |

On top of the fixed total, and growing with use:

- **Data through NAT and endpoints**: $0.045/GB through a NAT gateway (not a NAT instance), $0.01/GB through an interface endpoint. Pulling the sandbox image (several hundred MB) through the ECR endpoints is most of it.
- **CloudWatch logs**: $0.50/GB ingested, $0.03/GB-month stored. A few GB a month is a few dollars.
- **API Gateway, Lambda, SQS, Step Functions and S3**: cents a month at a team's PR volume, and mostly inside the free tier where it applies.
- **Each review** (below).

The interface endpoints are the largest line in `lean`. They are what keeps sandbox tasks off the internet, so they aren't optional.

## Per review

Each review is one Step Functions execution:

- **Control tasks** (Fargate, ARM64, 1 vCPU, 2 GiB, 50 GiB disk): one to prepare the run and one to post it.
- **Sandbox tasks** (Fargate, ARM64, 2 vCPU, 4 GiB, 30 GiB disk): one per batch, plus one per judged reply. `maxConcurrency` (4 by default) caps how many run at once for one PR.
- **Lambdas**: the gateway, the dispatcher, the presigner and the credential broker, each a short call per step.
- **Model usage**: the reviewer's tokens for each batch, and a fast-tier call for each judged reply. This is usually the largest part of a review's cost.

At the list prices above, a control task costs about $0.04 an hour and a sandbox task about $0.08 an hour. For example, a review of four batches that each take 8 minutes, with 5 minutes of control tasks, is about $0.05 of AWS compute. That's an illustration, not a measurement: batch times depend on the PR and the model. The model usage is billed separately (below).

Scheduled work runs on its own: the reconciler (every `reconcileIntervalMinutes`, 30 by default, no model calls) and the credential health check (every 6 hours, no model calls).

## Model usage

Where model usage is billed depends on the provider:

- **Amazon Bedrock** bills the AWS account, so AWS credits pay for it.
- **API keys** bill the vendor account the key belongs to.
- **Plan credentials** (Claude, ChatGPT, Cursor sign-ins) draw on that plan's limits. Read [what each vendor's terms say](providers.md) before using one.

Every attempt is recorded in the `provider_usage` table (tokens, cost where the CLI reports it, limit hits and fallbacks), and each review's summary comment ends with its usage per provider.

## Spend caps

`budgets` in the deploy config sets hard limits on model spend. Every cap is optional: with none set, nothing is capped, but each run's estimated cost is still recorded.

```ts
// lgtmoose.config.ts
budgets: {
  perPullRequest: { runsPerDay: 20, costPerDayUsd: 5 },
  perRepoMonthlyUsd: 150,
  monthlyUsd: 1000,
},
```

| Cap                            | Applies to                              | Resets                    | Lifted by                                                         |
| ------------------------------ | --------------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `perPullRequest.runsPerDay`    | runs that call a model, per PR          | 00:00 UTC                 | a review command from someone with write access, for that one run |
| `perPullRequest.costPerDayUsd` | estimated cost per PR                   | 00:00 UTC                 | the same                                                          |
| `perRepoMonthlyUsd`            | estimated cost per repository           | the 1st of the month, UTC | only a change to the deploy config                                |
| `monthlyUsd`                   | estimated cost for the whole deployment | the 1st of the month, UTC | only a change to the deploy config                                |

A [bootstrap from review history](learning.md#starting-with-your-history) counts against the monthly caps, the repository's and the deployment's, like a review run. It belongs to no PR, so the per-PR caps don't apply to it. It also has its own cap, `learnings.bootstrapMaxCostUsd` (5 USD by default).

A repository can set lower caps for itself in `.lgtmoose.yaml`, never higher ones. The file is read at the PR's base, like the rest of it, so a PR can't change its own caps:

```yaml
# .lgtmoose.yaml
budgets:
  per_pull_request:
    runs_per_day: 5
    cost_per_day_usd: 2
  monthly_usd: 40
```

### How the cost is estimated

Each batch's cost is the tokens its harness reported (input, output, cache reads and cache writes) times its model tier's price, in USD per million tokens. The defaults are the list prices of the Claude models the tiers map to by default:

| Tier       | Input | Output | Cache read | Cache write | Used by                                              |
| ---------- | ----- | ------ | ---------- | ----------- | ---------------------------------------------------- |
| `fast`     | 1     | 5      | 0.10       | 1.25        | reply judge, ticket checker, explainer, bootstrapper |
| `standard` | 3     | 15     | 0.30       | 3.75        | reviewer                                             |
| `deep`     | 5     | 25     | 0.50       | 6.25        | (not used yet)                                       |

Set `budgets.prices` for other models or a negotiated price, per tier and per field; unset fields keep the defaults. The same price applies to an API key, Bedrock and a plan sign-in, so a cap means the same whichever provider ran. For a plan, the estimate is what the same tokens would cost at API prices. A batch whose harness reported no tokens counts at its reported cost, or else at 60,000 input and 6,000 output tokens.

### What happens at a cap

The prepare step checks the caps before any batch is dispatched:

1. It reads what's been spent from the spend ledger (`spend_ledger`): each run's reservation until the run settles, then its reported cost. A reservation counts until it's settled, however long that takes: it's made only just before batches are dispatched, so it stands for spend that happened. The post step settles a run. The reconciler settles one that post never reached (a newer push stopped it, or it failed after its batches ran) once it's 6 hours old, from its batches' outputs; a batch that left no output keeps its estimate.
2. It estimates each batch: the deployment's average settled cost per batch over 30 days, once it has 10 batches of history, and the tier's default before that.
3. It keeps the batches that fit under every cap, in this order: replies to judge, `explain`s, linked tickets, then the review's batches in plan order (riskiest files first). It reserves their estimate.

Checking and reserving happen under one database lock, so two runs prepared at once can't both use the same headroom. A run can still end a little past a cap, by the difference between its estimate and what its batches used. A batch that's already running always finishes.

Batches that don't fit aren't dispatched. The run posts an incomplete review:

- the check run is titled **Spend cap reached**. Like any incomplete review it asks a person to look (`action_required`, or neutral with `gate.check_run: optional`), so a required check doesn't pass on a review that didn't run;
- the summary says which cap was reached, how many batches didn't run, and when it resets;
- the status label is the pending one, and nothing is approved;
- the files that weren't reviewed are reviewed by the next run, and the head doesn't count as reviewed.

A run that would run nothing at all, on a head whose last posted run was already stopped by the same cap, posts nothing: the PR already says why. A run for replies or an `explain` that a cap stops entirely also posts nothing, so the PR's review isn't replaced; the replies wait for the next run.

`@lgtmoose review` or `@lgtmoose full review` from someone with write access, as GitHub says now, runs once past the PR's own caps. The monthly caps always apply, whoever asks.

### Alerts

After each run settles, the control task logs `spend cap alert` as the deployment's or a repository's monthly spend passes 50%, 80% and 100% of its cap. On AWS it also writes the `BudgetUsed` metric (percent of `monthlyUsd`, namespace `LGTMoose`), and with `monthlyUsd` set the Workflow stack alarms at 50, 80 and 100. Those alarms notify the topic in `alarms`, like the others.

The dashboard's Usage page shows this month's spend in your repositories against the caps, and the deployment's total to org owners.

## What you can change

- **`profile`**: `lean` or `standard`, above. Switching is a redeploy that keeps the database ([Upgrading](upgrading.md#switching-profile)).
- **`providers[].models`**: the model for each tier. The reviewer runs on `standard`, the reply judge on `fast`.
- **`maxConcurrency`**: fewer batches at once makes a big PR slower but doesn't change its total model usage.
- **`batchStaggerSeconds`**: batches after the first wait this long (30 seconds by default) so they can read the first batch's prompt cache. `0` starts them together, and each one pays to write the shared prompt again. The wait adds wall-clock time, about `(batches − 1) × batchStaggerSeconds`, and does not add model tokens.
- **`providers[].thinkingTokens`**: a cap on thinking tokens for a tier, for Claude Code and the Agent SDK. Unset, the model decides. The CLI raises any cap under 1024 to 1024. The cap is per request, so a review that makes more requests can think more in total and cost more, and it can miss findings. Check a value with the eval suite (`pnpm --filter @lgtmoose/evals run eval --thinking-tokens <n>`) and with one real review before leaving it on. Codex and Cursor ignore it.

## What a batch sends the model

Most of a review's model cost is the prompt, not the findings. Each batch pays to write its prompt into the cache, then reads that cache again on every turn of the agent. The prompt is, in order:

1. Claude Code's own instructions and tools. This is the same for every batch and every review on that CLI version, so a later batch can read it from a cache an earlier batch wrote.
2. LGTMoose's reviewer rules and the built-in rule packs. Trusted, and the same on every batch.
3. The shared context: the repository's convention files, the pull request's title and body, and comments that are not attached to a file. A convention file that copies one already read is left out, even with its own title or a few lines of its own (at most a tenth of its lines). A bot comment's `<details>` block and HTML comments are left out. This text is the same on every batch of one run. When a run has more than one batch, Claude Code sends it as its own turn and returns an empty findings list; the diff comes in the next turn of the same session. A run with one batch sends it at the start of that batch's prompt, since no other batch would read the cache.
4. This batch only: its learnings, the inline comments on its own files, and its diff.

Because batches used to start together, none of them could read another's cache, and each one wrote the whole prefix. With `batchStaggerSeconds` above 0, batch 0 writes it and the others read it, which is about a tenth of the write price. A pull request's inline comments used to be copied into every batch; now a batch only sees the ones on its files.

A 33-file review of four batches (Sonnet 4.6, before this split) cost $2.30 of model usage: about $1.25 to write the prompt cache, $0.35 to read it back, and $0.69 of output, nearly all of it the model's thinking. Each batch's first request was 70k to 82k tokens, and the four batches started within two seconds, so each one wrote that prefix itself. The same pull request after this change, still four batches on Sonnet 4.6, settled at $0.90. The first batch wrote a 25,355-token shared prefix and the other three read those 25,355 tokens on their first request, writing none of it. Capping that review's thinking at 2000 tokens per request did not make the next run cheaper: its review turns thought 33,536 tokens against 24,888, because it made more requests, and it settled at $1.23. It also did not raise the blocking finding the uncapped run raised. The eval suite at that cap still found 17 of 17 seeded problems, with no false positive and the same 82.4% severity accuracy, and the fixtures cost $1.14 against $1.38. The cap is left unset.

- **`maxReplyJudgements`**: replies judged per run, 10 by default. 0 turns the reply judge off.
- **`learnings.embeddings`**: `none` (the default) ranks learnings by keywords with no calls; `bedrock` or `openai` add an embeddings call per batch, and when a learning is first ranked.
- **`tickets`**: off unless set. With Linear, each linked ticket (up to `maxPerPullRequest`, 3 by default) costs one fast-tier run per commit reviewed, plus a Linear API call. See [Ticket coverage](tickets.md).
- **`budgets`**: hard caps on model spend per PR, per repository and per month (above).
- **`.lgtmoose.yaml`**: `skip` globs keep files out of the review, so they cost nothing; `budgets` lowers the repository's caps.
- **`review.trigger` and `review.on_push`** in `.lgtmoose.yaml`: review only when a PR is ready (a label, a command or a trusted agent), and only once unless asked again. A PR with ten work-in-progress pushes then costs one or two reviews instead of ten. A run that waits costs one short control task and no model time. See [When reviews run](commands.md#when-reviews-run).
- **`review.wait_for_checks`** in `.lgtmoose.yaml`: review only once the PR's CI passes, so a push whose tests fail costs no model time. A run that reads the checks and waits costs one short control task. See [Waiting for CI](commands.md#waiting-for-ci).
- **`reviewDebounceSeconds`**: how long a push waits for the next one before its review starts (60 by default, up to 1800). A longer wait folds more pushes into one review.
- **Incremental reviews**: after the first review, a push reviews only the files whose change moved, and a superseded run's finished batches are reused.

The `review` and `full review` commands start a run on request; only the PR's author or someone with write access can use them, so people commenting on a public repository can't spend your model budget.
