# Architecture

## Core rule

The model only reads repo files and returns findings as JSON. Plain code does everything else: holding the GitHub token, posting, labels, the review decision, memory writes and bookkeeping. The sandbox that runs the model holds one short-lived model credential and can reach only that vendor's API.

## Components

| Component         | Runs on                               | Holds GitHub credentials | Job                                                                       |
| ----------------- | ------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Gateway           | Lambda behind API Gateway             | Webhook secret only      | Verify HMAC, dedupe deliveries, enqueue                                   |
| Queue             | SQS FIFO, group = `owner/repo#pr`     | No                       | Order jobs per PR                                                         |
| Dispatcher        | Lambda                                | No                       | Start a Step Functions run, supersede older runs                          |
| Review workflow   | Step Functions                        | No                       | prepare → map batches → cross-file → map verify → post                    |
| Control tasks     | Fargate                               | Yes                      | Clone and plan; dedupe, decide and post                                   |
| Sandbox tasks     | Fargate, private subnet, egress proxy | **No**                   | Run the harness (`claude -p`, `codex exec`, `cursor agent`) on one batch  |
| Credential broker | Lambdas + Secrets Manager             | No                       | Lease each sandbox task one model credential; write back refreshed tokens |
| Reconciler        | Scheduled Lambda                      | Yes (read, labels)       | Re-queue missed PRs updated recently, re-sync labels. No model calls.     |
| State             | RDS Postgres + pgvector, S3           | n/a                      | Runs, findings, learnings, usage, transcripts                             |

The reconciler runs every `reconcileIntervalMinutes` (30 by default). It queues a review only for a PR updated within `reconcileLookbackHours` (24 by default, at least the interval) whose head no run has started for. Older PRs are counted as `SkippedStale` and left alone, so a first run after a deploy, or a newly added repository, doesn't review every old open PR. Status-label re-syncs and the restore after a force-push back to a reviewed commit apply to every open PR, however old.

## Harnesses

Each vendor's official CLI runs headless behind a small adapter, restricted to read-only tools and validated with zod:

- `claude-code`: OAuth token from `claude setup-token`, `ANTHROPIC_API_KEY`, or Bedrock/Vertex
- `codex`: ChatGPT sign-in (`auth.json`), Codex access token, or `OPENAI_API_KEY`
- `cursor-agent`: user or service-account API key
- `agent-sdk`: Claude Agent SDK in-process, for API-key and Bedrock users

Before using a plan credential, read [Providers](providers.md): what each vendor's terms say, with sources, and the recommended credential per vendor. `lgtmoose setup` starts with a Bedrock provider, which needs no stored key.

### Providers, tiers and fallback

- **Fallback order.** `providers` in `lgtmoose.config.ts` is an ordered list. Each role (`reviewer`, `crossFile`, `verifier`, `replyJudge`, `ticketExtractor`) starts on the provider `roles` gives it, or the first one. It falls back to the others in order.
- **When a run falls back.** A rate limit, a used-up plan or a rejected credential sends the run to the next provider. Any other failure, such as a timeout or invalid output, fails the batch, since another provider would most likely fail the same way.
- **Cooldowns.** A provider that hit a limit sits out until its reset time, when the CLI gives one. Otherwise it sits out for a default: a minute for a rate limit, an hour for a used-up plan, ten minutes for a rejected credential. Cooldowns live in the `provider_cooldowns` table, so every batch and run skips that provider without calling it.
- **Tiers.** Each provider maps the tiers `fast`, `standard` and `deep` to models through `models`. Claude Code and the Agent SDK default to the aliases `haiku`, `sonnet` and `opus`, which follow each family's newest model. Codex and Cursor default to their CLI's own model; Codex turns the tier into a reasoning effort.
- **Usage.** Every attempt is recorded in `provider_usage`: tokens, cost, limit hits and the provider it fell back to. The summary comment ends with usage per provider.

### Batches in the review workflow

- **In parallel.** The Step Functions map runs up to `maxConcurrency` batches of a review at once (4 by default). It runs fewer when the reviewer's stored credential allows fewer at once (its `concurrency`, see [Credentials](credentials.md)). The credential broker's leases also cap each credential across reviews. A batch waiting for a free slot waits in its lease step, so its sandbox task's timeout doesn't start until it has one.
- **Falling back.** Each sandbox task runs one provider. After an attempt on the reviewer's provider, the workflow reads the batch's output. A rate limit, a used-up plan, a rejected credential, a prompt too large for that provider, or no usable output sends the batch to the next provider's sandbox task, in `providers` order. A failure there on the last provider, or any other failure, stands. A batch with no findings at the end is failed, so the review is incomplete and can't approve.
- **Prompt caching.** The part of the reviewer prompt every batch shares (the role's instructions and the built-in and private rule packs) is sent as the harness's system prompt. The Agent SDK harness caches it. The CLI harnesses put it first, followed by the repository's rule packs, conventions, the PR, and the batch's diff last. Repository content is never in the system part.
- **Notes for the cross-file pass.** Each batch's output keeps the reviewer's notes (exports, env vars, endpoints and props it adds, changes or relies on), cut to at most 30 notes of 500 characters. They're model output, so the cross-file pass treats them as leads to check.

One AWS account and region holds one install. `lgtmoose setup` writes fixed Secrets Manager names (`lgtmoose/github-app`, `lgtmoose/github-webhook-secret`), so a second install there would overwrite the first one's App credentials. Use another account or region for staging until deployment names land.

## Security controls

- The model can't approve. The decision is a pure function of verified findings.
- Learnings are written only through a policy check (author permission and provenance). The model can only propose them.
- Protected categories (`authz`, `tenant_scoping`, `money`, `secrets`) can't be suppressed by learnings or dedupe.
- PR code is never executed.
