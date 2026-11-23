# Troubleshooting

## Deploying

**`deploy` fails building images.** It builds ARM64 images, so Docker must be running: Docker Desktop, or on x86 Linux, Docker with QEMU emulation for arm64 (for example `docker run --privileged --rm tonistiigi/binfmt --install arm64`).

**`deploy` is refused by AWS.** It uses your current AWS credentials (`aws sso login`, `AWS_PROFILE`) and the region in `lgtmoose.config.ts`. [Getting started](index.md#aws-permissions) lists the permissions a scoped role needs.

**`deploy` says the config is invalid.** The message names the key, such as `providers[0].auth`. The [configuration reference](configuration.md) has every key, its type and its default.

**A second install in the same account overwrites the first.** One account and region holds one install, because the secret and stack names are fixed. Use another account or region for staging.

## No review on a PR

Check these in order:

1. **Shadow mode.** `shadow: true`, the default, records reviews to `shadow/` in the artifact bucket and the log instead of posting them. Set `shadow: false` and deploy again to post.
2. **The PR is one LGTMoose ignores.** The gateway drops drafts, PRs opened by bots, PRs labelled `skip-lgtmoose`, and repositories whose owner isn't in `allowedOrgs`.
3. **The PR is paused.** Someone ran `@lgtmoose pause`. `@lgtmoose resume` (write access) starts automatic reviews again; `@lgtmoose review` runs one anyway.
4. **The webhook didn't arrive.** In the GitHub App's settings, under Advanced, check recent deliveries. `deploy` points the webhook at the gateway; run it again if the URL is wrong. The reconciler queues reviews that a missed webhook lost, for PRs updated within `reconcileLookbackHours` (24 by default).
5. **A job failed.** Jobs that fail for good go to a dead-letter queue, which raises the `DeadLetterAlarm` in `Lgtmoose-Api` (webhook jobs) or the `ConversationDeadLetterAlarm` in `Lgtmoose-Workflow` (comments). The Step Functions console shows each review's execution and the step that failed.

## A review that doesn't approve

The summary comment says why. Common reasons:

- **The review is incomplete.** A batch had no valid output after every provider in `providers` was tried, so the review can't approve. The summary says so, and the check asks a person to look.
- **A prompt-injection attempt was flagged.** Text aimed at an AI reviewer on a line the PR adds is a blocking `prompt_injection` finding; in the title, description or an outsider's comment it holds approval for the run. If it's a false positive in a file that's meant to contain such text (tests for a prompt detector, docs about prompt injection), list it under `injection.allow` in `.lgtmoose.yaml` on the base branch. Someone other than the PR's author with write access can also resolve the finding.
- **A blocking finding is still open.** Resolving its thread only counts when someone other than the PR's author, with write access, resolves it. A reply saying it's fixed counts only when the code check agrees and the reviewer doesn't raise it again. See [Commands](commands.md).
- **`gate.approve: false`** in `.lgtmoose.yaml` posts COMMENT instead of APPROVE on a clean review.

LGTMoose's approval may not count towards GitHub's required reviews: see [Providers](providers.md#github-do-app-approvals-count-towards-required-reviews). Make the `LGTMoose` check run a required status check instead.

## Model credentials

**`pnpm lgtmoose auth list`** shows which providers have a stored credential, and which lack one.

**A credential alarm fired.** Each stored credential has a `CredentialAlarm-<provider id>` alarm on the `CredentialProblem` metric. It fires when the secret is missing, being deleted or has no current version, when a Claude token is close to its year's expiry, or when a run was refused for auth (an expired or revoked token). Run `pnpm lgtmoose auth <method>` again for that provider. The credential broker's log says which run hit it.

**A model alarm fired, or deploy warned about a model.** `Lgtmoose-Workflow-ModelAlarm-<provider id>` fires when a model a provider is pinned to can't be called: the inference profile doesn't exist in the region, a bare model ID needs a profile, model access isn't granted, or the model's agreement isn't accepted. The health check's `model unavailable` log line, and the deploy warning, name the tier, model ID, region and fix. `pnpm lgtmoose auth bedrock` lists the profiles and models the region offers. To see its state: `aws cloudwatch describe-alarms --alarm-name-prefix Lgtmoose-Workflow-ModelAlarm`. See [Model checks](credentials.md#model-checks).

**Reviews slow down or move to another provider.** A rate limit, a used-up plan or a rejected credential sends a batch to the next provider in `providers`, and the provider sits out for a while (the `provider_cooldowns` table). The summary comment ends with usage per provider, including limit hits and fallbacks.

**A provider only runs a few tasks at once.** Each credential has a concurrency limit across every review: 1 for a ChatGPT sign-in, 2 by default for other plan credentials, 16 for API keys. Batches wait for a free slot. See [Providers and auth](credentials.md#the-credential-broker).

**The sandbox can't reach a host.** Sandbox tasks reach only their providers' model APIs and `extraEgressHosts`, through the egress proxy. A refused request counts in the `EgressBlocked` metric, and the proxy's log names the host. Add a regional endpoint or gateway to `extraEgressHosts` if you need one; GitHub's hosts are always refused.

## Trying a review locally

`pnpm lgtmoose review owner/repo#123 --dry-run` reviews one PR on your machine and prints what LGTMoose would post, without posting anything. It needs a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`) and a Claude Code credential in the environment. Behind an HTTPS proxy, set `NODE_USE_ENV_PROXY=1`.

## Logs

Each part logs to its own CloudWatch log group: the gateway (`Lgtmoose-Api`), the egress proxy (`Lgtmoose-Proxy`), and the dispatcher, conversation Lambda, reconciler, credential broker, presigner and review tasks (`Lgtmoose-Workflow`). Most are kept for a month; the credential broker's audit log is kept longer (3 months on `lean`, a year on `standard`). No credential is ever logged.
