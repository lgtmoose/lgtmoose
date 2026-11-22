# Architecture

## Core rule

The model only reads repo files and returns findings as JSON. Plain code does everything else: holding the GitHub token, posting, labels, the review decision, memory writes and bookkeeping. The sandbox that runs the model holds one short-lived model credential and can reach only that vendor's API.

## Components

| Component         | Runs on                               | Holds GitHub credentials | Job                                                                                   |
| ----------------- | ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| Gateway           | Lambda behind API Gateway             | Webhook secret only      | Verify HMAC, dedupe deliveries, enqueue                                               |
| Queue             | SQS FIFO, group = `owner/repo#pr`     | No                       | Order jobs per PR                                                                     |
| Dispatcher        | Lambda                                | No                       | Start a Step Functions run, supersede older runs                                      |
| Review workflow   | Step Functions                        | No                       | prepare → map batches → cross-file → map verify → post                                |
| Control tasks     | Fargate                               | Yes                      | Clone and plan; dedupe, decide and post                                               |
| Sandbox tasks     | Fargate, private subnet, egress proxy | **No**                   | Run the harness (`claude -p`, `codex exec`, `cursor agent`) on one batch              |
| Credential broker | Lambdas + Secrets Manager             | No                       | Lease each sandbox task one model credential; write back refreshed tokens             |
| Conversation      | Lambda, fed by its own FIFO queue     | Yes (comments)           | `@lgtmoose` commands; replies queued for the judge. No model calls.                   |
| Reconciler        | Scheduled Lambda                      | Yes (read, labels)       | Re-queue missed PRs updated recently, re-sync labels, read reactions. No model calls. |
| State             | RDS Postgres + pgvector, S3           | n/a                      | Runs, findings, learnings, usage, transcripts                                         |
| Dashboard         | CloudFront + S3, its own API Lambda   | OAuth client only        | GitHub sign-in for org members; open findings and runs ([Dashboard](dashboard.md))    |

The reconciler also reads reactions on LGTMoose's inline comments and writes the feedback report: see [feedback signals](feedback.md).

The reconciler runs every `reconcileIntervalMinutes` (30 by default). It queues a review only for a PR updated within `reconcileLookbackHours` (24 by default, at least the interval) whose head no run has started for. Older PRs are counted as `SkippedStale` and left alone, so a first run after a deploy, or a newly added repository, doesn't review every old open PR. Status-label re-syncs and the restore after a force-push back to a reviewed commit apply to every open PR, however old.

When a person resolves one of LGTMoose's review threads, the `pull_request_review_thread` webhook marks its finding `resolved_by_human` straight away, without a review run; unresolving it opens the finding again. The person's latest action wins. LGTMoose never reopens a finding a person resolved on its own. The decision and label on GitHub catch up on the next review.

Resolving a thread isn't a way round the gate. A blocking finding, or one in a protected category, counts as resolved only when someone other than the PR's author, with write access or higher on the repository, resolved it. The dispatcher holds no GitHub credential, so for these it records the resolution as not counted and leaves the finding open. The next run's thread sync reads who resolved each thread (`resolvedBy`) and their permission (the collaborators API), and resolves the finding then if they qualify. Otherwise it stays open, and the summary says that a resolved thread still counts. Anyone, the author included, may resolve a should_fix or nit finding.

### How carried findings close

A finding stays open while its cited lines are there. Its line changing or going away makes it `outdated`. A person resolving its thread, declining it, or replying that it's fixed (which the reply judge checks) closes it. A fix often lands somewhere else, though: the caller now passes the right value, a guard goes in before the call, the router mounts the handler behind a check. The cited line doesn't change, so before the recheck the finding stayed open and kept the decision at "changes requested".

On an incremental review, the prepare step now picks our open blocking and should-fix findings that the new commits may have fixed. The PR's own changed files come first (those it changes from its merge base), so a merge of the base branch can't crowd them out of the imports read or the diff. It takes those whose file the commits changed, and those whose file is related to a changed one. A file is related when it's in the same directory, or when either file imports the other by a relative path, read at head. That's plain code, and it errs on the side of checking. The planner's cross-file pass works on the reviewer's notes, not an import graph, so the recheck reads imports itself. It takes blocking findings first, then should-fix, oldest first, at most 10 (the verifier's run size). They go to one recheck batch on the fast tier, in the sandbox like any batch, with:

- each finding;
- the code it cited when it was raised;
- the diff since the last review of the changed files that matter;

all in untrusted blocks. This run's reviewer isn't shown our comments on those findings, as for a fix someone claimed in a reply, so a problem it raises again it found on its own. Should the recheck not run after all (the review didn't come out incremental, or the caps leave it out), the review's prompts are built again with those comments in. Its output has the verifier's shape, with its own schema (`recheckOutputSchema`) whose descriptions reverse the burden: `confirmed` means the problem is still there, and the recheck says so when it's unsure or can't tell.

The post step closes a finding as fixed only when all of these hold:

- the recheck's verdict says the problem is gone;
- this run's review didn't raise it again;
- the finding's file, followed to its name at head, was reviewed if this review changed it: a review batch that failed, timed out or was capped, or a file the planner skipped, says nothing about it. A file renamed since the finding was raised must have been reviewed under its new name, since the recheck looked for it under the old one;
- in a protected category (`authz`, `tenant_scoping`, `money`, `secrets`), the verdict names, by its full repository path, one of the changed files related to the finding as where the fix is. A file name alone (`index.ts`), or a path inside a longer one, doesn't count.

A failed batch, a missing verdict or any doubt keeps the finding open. The decision is then made again without it. Nothing is closed yet: the post step works this out in memory, and closes the findings only once it holds the run's claims and has checked the run still counts. A stale run (the PR moved on or closed) closes nothing, also on a retry after its review was posted, unless an earlier attempt already saved what it would close (read again once the claims are held, as an attempt that held them meanwhile may have saved it; when its list differs from this attempt's, the decision is made again from it): then the closes and their replies are finished, so no finding is left closed without its note. A stale retry that closes nothing writes its summary, check run and label with those findings open, as the store has them, and neither does a run that another run's review covers: that review is the one the PR shows, and it still counts them. Its thread gets a reply saying the commit it was fixed at, with the recheck's reason, escaped, and the thread is resolved. The event is recorded as `fixed`, by LGTMoose, at that commit.

There's no recheck on a full review, on a run that only judges replies or answers explains while the code waits for a trigger, or for a finding whose reply the judge reads in the same run. The recheck batch counts towards the spend caps like any batch. It's reserved last, so near a cap it's the batch left out, never a review batch, and a run that loses only the recheck isn't a capped review. When a cap leaves out any review batch, there's no recheck and nothing is reserved for it: "not raised again" means nothing for a file nobody re-reviewed. A run whose review batches are all left out is quiet as before, even when the cheap recheck would have fit. The replies and resolves are written after the review, the check run, the summary and the label, so they never hold those up. The post step saves what it will close before it closes anything, so a retry after a crash closes the rest. A finding a person resolved or declined meanwhile gets no reply. Each reply and each resolve is saved as it's written, so none is written twice. One that fails for now (a 5xx, a rate limit, threads that can't be read) is written by the step's retry. One that fails for good is logged and skipped, so it can never hold up the post. That's a 4xx other than 401, 408, 409 and 429 (but a rate-limited 403 is retried), a GraphQL `NOT_FOUND`, `FORBIDDEN` or `UNPROCESSABLE` on the resolve, or an error that's neither GitHub's answer nor the network failing (a parse error, a bug). After three attempts at the step, or on the post step's last attempt. That's when either count says so: post's own count of its starts (`post-attempts.json`, counted first thing in the control task), or the state's retry count (`LGTMOOSE_POST_RETRY`), against `LGTMOOSE_POST_ATTEMPTS`. The own count misses an attempt that died before counting and carries over into a redriven execution; the retry count includes tasks that never started. Giving up a note early is cheaper than failing a posted run. The docker compose runner passes its own try number and total the same way; with no total known at all, any attempt may be the last, so none fails over these notes, whatever is left is logged and given up: the findings are closed either way, and a run whose review is out isn't failed over a note on a thread. A reply that fails for good still resolves the thread. A thread is taken for gone only when the PR's thread list was read in full and none starts at the finding's comment; a list read in part leaves the resolve to the retry. A reply that timed out may have reached GitHub anyway; its retry then posts it again, a rare duplicate of the same note. In shadow mode the reply and the resolve are logged instead of written.

Other reviewers' unresolved inline comments count too. Those from other bots (CodeRabbit, say), or from people who are owners, members or collaborators, that are marked Critical (blocking), Major or a bug (should fix), on files the review covers and still on the current diff, count towards the decision as open findings. The summary lists them with who raised them. They're never posted again, never stored as LGTMoose's own, and their text never reaches a model or the summary: only its opening words are read, for the severity. When one is on a file LGTMoose reviewed and none of its own findings is within a few lines, the run writes it to `misses.json` (path, line, severity and source, no text) for the evals.

## How a review runs

Each review job is one execution of the review state machine (`StateMachineArn` in the Workflow stack's outputs):

1. **Prepare** (control task): records the run, clones and plans the PR, and uploads the checkout and each batch's input to `runs/<run id>/` in the artifact bucket. A run for a head that's no longer the PR's head stops here as superseded.
2. **Batches** (sandbox tasks, `maxConcurrency` at once): each runs the reviewer on one batch. Sandbox tasks have no S3 access of their own; a small Lambda hands each one presigned URLs for its own batch.
3. **Post** (control task): reads the batches' outputs and posts one review, the check run, the summary comment and the status label. A batch without a valid output makes the review incomplete, so it can't approve.

A step that fails for good marks the run failed and posts nothing more: a failure before post leaves the PR untouched. With `shadow: true` in `lgtmoose.config.ts` (the default for now), post records what it would post to `shadow/` in the bucket and the log instead.

People talk to LGTMoose through `@lgtmoose` commands and replies on its findings: see [Commands](commands.md). What it learns from them is in [Learning](learning.md).

With a ticket provider set up, prepare also reads the tickets the PR names (in the control task, with the provider's key) and adds a ticket checker batch per ticket, run in the sandbox on the fast tier. Post shows the coverage table and counts missing core requirements as should-fix findings, capped: see [Ticket coverage](tickets.md).

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

The full threat model, with the test behind each control, is on the [Security](security.md) page.

- The model can't approve. The decision is a pure function of verified findings.
- A prompt-injection detector, in plain code, scans what the reviewer read. Text aimed at an AI reviewer, chat-format markup, attempts to break out of an untrusted block, bidirectional controls and hidden Unicode on a line the PR adds raise a blocking `prompt_injection` finding there. The same in the PR's title, description, or a comment by someone outside the repository holds approval for the run. `injection.allow` in `.lgtmoose.yaml` lists files whose added lines aren't scanned (tests and docs about prompt injection). Like protected categories, its findings are dropped as duplicates only on an exact match.
- `extraEgressHosts` refuses GitHub's hosts, so no deploy config can let the sandbox reach GitHub.
- Learnings are written only through a policy check (author permission and provenance from GitHub, redaction before storage), and the model can only propose them. Learning text reaches the reviewer only inside an untrusted block. See [Learning](learning.md).
- Protected categories (`authz`, `tenant_scoping`, `money`, `secrets`) can't be suppressed by learnings or dedupe.
- PR code is never executed.
