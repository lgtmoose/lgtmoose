# LGTMoose 🫎

A self-hosted, open-source AI pull request reviewer. Fork it, deploy it to your own AWS account with one command, and teach it by tagging `@lgtmoose` in review comments.

> **Status: pre-release.** The review workflow, commands and learnings are built, but no release has been cut and the stack hasn't yet passed its end-to-end smoke test on a real AWS account. Reviews run in shadow mode by default: they're recorded, not posted.

- **Reviews every PR** as a GitHub App: inline comments, a summary, a status label and a check run. Plain code, not the model, decides whether to approve.
- **Learns from your team.** `@lgtmoose learn: …` and declined findings become scoped learnings, stored in your database, and only people with write access can make them take effect.
- **Runs on the model access you already have**: Amazon Bedrock, Anthropic or OpenAI API keys, or Claude, ChatGPT and Cursor credentials where the vendor's terms allow it ([what each vendor's terms say](docs/providers.md)). When one provider's limit runs out, it falls back to the next.
- **Stays in your account.** The model runs in a sandbox with no GitHub token and network access only to its model API.

<!-- TODO: a screenshot of a real review, at docs/images/review.png, once the stack has run on a real repository. -->

See [an example summary comment](docs/example-review.md), rendered from the test data.

## Quickstart

You need Node 24, pnpm 10, Docker, the AWS CLI signed in to the account to deploy to, and a GitHub organization or account to install the App in.

```bash
git clone https://github.com/lgtmoose/lgtmoose && cd lgtmoose && pnpm install
```

```bash
pnpm lgtmoose setup
```

```bash
pnpm lgtmoose auth bedrock
```

```bash
pnpm lgtmoose deploy
```

- **`setup`** creates the GitHub App, stores its keys in AWS Secrets Manager and writes `lgtmoose.config.ts`.
- **`auth`** stores or checks a model provider's credential: `bedrock` (the default, no key to store), `claude`, `codex`, `cursor`, `api-key` or `vertex`.
- **`deploy`** bootstraps the AWS CDK the first time, deploys every stack, points the App's webhook at the gateway and prints the install link.

Then install the App on your repositories. [Getting started](docs/index.md) covers the AWS permissions a scoped role needs, Docker on x86 Linux, and pinning Bedrock models.

## Documentation

The docs are in [`docs/`](docs/index.md), and published to GitHub Pages from `main`.

- [Architecture](docs/architecture.md): the components, how a review runs, and the security controls
- [Configuration reference](docs/configuration.md), [Providers and auth](docs/credentials.md), [Rule packs](docs/rule-packs.md)
- [Commands](docs/commands.md), [Learning](docs/learning.md), [Feedback signals](docs/feedback.md), [Ticket coverage](docs/tickets.md), [Dashboard](docs/dashboard.md), [Evals](docs/evals.md)
- [Costs](docs/costs.md), [Troubleshooting](docs/troubleshooting.md), [Upgrading](docs/upgrading.md), [Releasing](docs/releasing.md)
- [Security](docs/security.md), and the [security policy](SECURITY.md) for reporting a vulnerability

## Repository layout

```
apps/cli/        lgtmoose CLI (setup · auth · deploy · destroy · review --dry-run)
apps/control/    control task and Lambdas: prepares batches, posts results, commands, reconciler
apps/gateway/    webhook gateway: verifies, dedupes and queues GitHub deliveries
apps/sandbox/    sandbox task: runs a model on one batch; one model credential, no GitHub token
apps/egress-proxy/ the sandbox's only way out: CONNECT proxy with an exact-host allowlist
packages/core/   pure domain logic: findings, fingerprints, decision
packages/config/ schemas and defaults for lgtmoose.config.ts and .lgtmoose.yaml
packages/db/     Postgres schema and migrations
packages/git/    local checkouts: clone at a SHA, review diffs, comment positions
packages/harness/ agent CLIs run headless on one batch: read-only tools, zod-checked JSON
packages/learnings/ the learnings store, its write policy and retrieval
packages/evals/   eval fixtures, scores, the recall gate and the provider matrix
packages/pipeline/ one whole review in-process, without posting (review --dry-run, evals)
packages/planner/ what to review and in what order: skips, risk tiers, batches, reading depth
packages/roles/  agent roles: reviewer and reply-judge prompts, rule packs, untrusted-text wrapping
packages/poster/  posts a run: one review, inline comments, check run, summary, labels
packages/summary/ the PR summary comment and status label sync
infra/cdk/       AWS CDK app
infra/sandbox/   the sandbox image: pinned agent CLIs
deploy/compose/  docker compose deployment for hosts other than AWS (core built, not runnable yet)
docs/            the documentation site
```

## Development

Requires Node 24 and pnpm 10.

```bash
pnpm install
```

```bash
pnpm run check   # format, lint, typecheck, test, build, run the built CLI, migrations, cdk synth
```

The migration runner also has an integration test against a real Postgres with pgvector (`test:integration`). CI always runs it; locally it runs when `LGTMOOSE_TEST_DATABASE_URL` points at an admin connection:

```bash
pnpm db:test:start   # the same pinned image as CI, from tools/test-postgres/Dockerfile
```

```bash
LGTMOOSE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm turbo run test:integration
```

After changing a config schema in `packages/config`, regenerate the JSON Schemas and the configuration reference:

```bash
pnpm --filter @lgtmoose/config schema && pnpm --filter @lgtmoose/config docs
```

## Roadmap

1. **M1:** skeleton in shadow mode: setup wizard, CDK stacks, gateway, first reviewer, `review --dry-run`
2. **M2:** Step Functions workflow, sandbox tasks, deterministic decision and posting
3. **M3:** providers: Codex, Cursor, Bedrock, API keys, credential broker, fallback chain
4. **M4:** quality: parallel batches, cross-file pass, verifier, evals
5. **M5:** conversation and learning: reply judge, commands, learnings, dashboard
6. **M6:** public release v0.1.0

## License

[Apache-2.0](LICENSE)
