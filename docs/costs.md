# Costs

LGTMoose runs in your AWS account, so you pay AWS for what it deploys, and your model vendors for what the reviews use. There's no LGTMoose service to pay for. This page lists what costs money and what you can change; it gives no prices, since they change by region and over time. Use the [AWS Pricing Calculator](https://calculator.aws/) with the figures below.

## Always on

These run whether or not anyone opens a PR. `profile` in `lgtmoose.config.ts` picks the size:

| Part                                                 | `lean` (default)                         | `standard`                                         |
| ---------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| Database                                             | RDS PostgreSQL on `db.t4g.micro`, one AZ | Aurora PostgreSQL Serverless v2, writer and reader |
| NAT for the app subnets                              | one `t4g.nano` NAT instance              | two NAT gateways                                   |
| Egress proxy (Fargate, ARM64, 0.25 vCPU, 512 MiB)    | one task                                 | two tasks                                          |
| Interface VPC endpoints (ECR, Secrets Manager, Logs) | in one AZ                                | in each AZ                                         |

Also always there, but small: Secrets Manager secrets (one for the GitHub App, one for the webhook secret, the database's, and one per stored provider credential), the S3 artifact bucket, and CloudWatch logs (most kept a month).

The database and NAT are usually most of the fixed cost. `lean` is meant for one team; `standard` for when the database and proxy shouldn't depend on one AZ.

## Per review

Each review is one Step Functions execution:

- **Control tasks** (Fargate, ARM64, 1 vCPU, 2 GiB, 50 GiB disk): one to prepare the run and one to post it.
- **Sandbox tasks** (Fargate, ARM64, 2 vCPU, 4 GiB, 30 GiB disk): one per batch, plus one per judged reply. `maxConcurrency` (4 by default) caps how many run at once for one PR.
- **Lambdas**: the gateway, the dispatcher, the presigner and the credential broker, each a short call per step.
- **Model usage**: the reviewer's tokens for each batch, and a fast-tier call for each judged reply. This is usually the largest part of a review's cost.

Scheduled work runs on its own: the reconciler (every `reconcileIntervalMinutes`, 30 by default, no model calls) and the credential health check (every 6 hours, no model calls).

## Model usage

Where model usage is billed depends on the provider:

- **Amazon Bedrock** bills the AWS account, so AWS credits pay for it.
- **API keys** bill the vendor account the key belongs to.
- **Plan credentials** (Claude, ChatGPT, Cursor sign-ins) draw on that plan's limits. Read [what each vendor's terms say](providers.md) before using one.

Every attempt is recorded in the `provider_usage` table (tokens, cost where the CLI reports it, limit hits and fallbacks), and each review's summary comment ends with its usage per provider.

## What you can change

- **`profile`**: `lean` or `standard`, above.
- **`providers[].models`**: the model for each tier. The reviewer runs on `standard`, the reply judge on `fast`.
- **`maxConcurrency`**: fewer batches at once makes a big PR slower but doesn't change its total model usage.
- **`maxReplyJudgements`**: replies judged per run, 10 by default. 0 turns the reply judge off.
- **`learnings.embeddings`**: `none` (the default) ranks learnings by keywords with no calls; `bedrock` or `openai` add an embeddings call per batch, and when a learning is first ranked.
- **`.lgtmoose.yaml`**: `skip` globs keep files out of the review, so they cost nothing.
- **Incremental reviews**: after the first review, a push reviews only the files whose change moved, and a superseded run's finished batches are reused.

The `review` and `full review` commands start a run on request; only the PR's author or someone with write access can use them, so people commenting on a public repository can't spend your model budget.
