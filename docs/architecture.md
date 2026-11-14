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

When a person resolves one of LGTMoose's review threads, the `pull_request_review_thread` webhook marks its finding `resolved_by_human` straight away, without a review run; unresolving it opens the finding again. The person's latest action wins. LGTMoose never reopens a finding a person resolved on its own. The decision and label on GitHub catch up on the next review.

Resolving a thread isn't a way round the gate. A blocking finding, or one in a protected category, counts as resolved only when someone other than the PR's author, with write access or higher on the repository, resolved it. The dispatcher holds no GitHub credential, so for these it records the resolution as not counted and leaves the finding open. The next run's thread sync reads who resolved each thread (`resolvedBy`) and their permission (the collaborators API), and resolves the finding then if they qualify. Otherwise it stays open, and the summary says that a resolved thread still counts. Anyone, the author included, may resolve a should_fix or nit finding.

Other reviewers' unresolved inline comments count too. Those from other bots (CodeRabbit, say), or from people who are owners, members or collaborators, that are marked Critical (blocking), Major or a bug (should fix), on files the review covers and still on the current diff, count towards the decision as open findings. The summary lists them with who raised them. They're never posted again, never stored as LGTMoose's own, and their text never reaches a model or the summary: only its opening words are read, for the severity. When one is on a file LGTMoose reviewed and none of its own findings is within a few lines, the run writes it to `misses.json` (path, line, severity and source, no text) for the evals.

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
- Learnings are written only through a policy check (author permission and provenance). The model can only propose them. `@lgtmoose/learnings` enforces it:
  - The author, the PR, the comment and the author's permission come from GitHub, never from the proposal.
  - A repo or path learning is active at once for an author with write access or higher on the repo. An org-wide one needs an owner of the org (the org memberships API), since admin on one repo is open to anyone who creates a repo. Anything else waits as `pending` until someone with that access approves it; approving and forgetting need the same access.
  - The text is scanned and redacted before it's stored, pending ones included: tokens, keys, credentials in URLs, emails, phone and card numbers.
  - `forget` retires a learning; its row and `learning_events` history stay.
- Protected categories (`authz`, `tenant_scoping`, `money`, `secrets`) can't be suppressed by learnings or dedupe. A learning that could quiet findings (`accepted_pattern`, `scoping`, `correction`) can't name one, and retrieval checks `mayLearningSuppress` for every finding a learning would quiet, learnings with no category included.
- Learning text is proposal text from comments or the model. Retrieval puts it in an untrusted block in the prompt, never with the instructions.
- PR code is never executed.
