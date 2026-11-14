# LGTMoose 🫎

A self-hosted, open-source AI pull request reviewer. Fork it, deploy it to your own AWS account with one command, and teach it by tagging `@lgtmoose` in review comments.

> **Status: pre-alpha.** Nothing here reviews code yet. Follow the roadmap below.

## What it will do

- **Review every PR** as a GitHub App: inline comments, a summary, a status label and a required check run.
- **Learn from your team.** `@lgtmoose learn: …` and declined findings become scoped learnings, stored in your database and synced back to the repo for review.
- **Run on the model access you already have**: Amazon Bedrock, Anthropic or OpenAI API keys, or Claude, ChatGPT and Cursor plan credentials where the vendor's terms allow it ([what each vendor's terms say](docs/providers.md)). Different providers can do different jobs, and it falls back to the next one when a plan runs out.
- **Stay in your account.** The model runs in a sandbox with no GitHub token and network access only to its model API. Plain code, not the model, posts reviews, decides and writes memory.

## Quickstart (planned)

```bash
git clone https://github.com/lgtmoose/lgtmoose && cd lgtmoose && pnpm install
pnpm lgtmoose setup     # creates the GitHub App, stores its keys in AWS Secrets Manager
pnpm lgtmoose auth bedrock   # or: claude · codex · cursor · api-key
pnpm lgtmoose deploy    # cdk bootstrap (first time) and deploy, points the App's webhook at the gateway, prints the install link
```

`deploy` builds the control and sandbox container images for ARM64, so it needs Docker running: Docker Desktop, or on x86 Linux, Docker with QEMU emulation for arm64 (for example `docker run --privileged --rm tonistiigi/binfmt --install arm64`).

`deploy` uses your current AWS credentials (for example `aws sso login` or `AWS_PROFILE`) and the region in `lgtmoose.config.ts`. Administrator access is simplest. A scoped role needs to assume the CDK bootstrap roles and create the bootstrap stack, plus the calls the CLI makes itself:

- `sts:GetCallerIdentity`
- `cloudformation:DescribeStacks`
- `secretsmanager:GetSecretValue`, `CreateSecret` and `PutSecretValue` on `lgtmoose/*` (setup writes them)
- `rds:DescribeDBInstances`, `DescribeDBClusters`, `ModifyDBInstance`, `ModifyDBCluster`, `StartDBInstance` and `StartDBCluster` (deploy checks the database's deletion protection, and destroy turns it off)
- For `auth`: `secretsmanager:CreateSecret`, `UpdateSecret`, `TagResource` (also needed to create a tagged secret), `RestoreSecret`, `DeleteSecret` and `DescribeSecret` on `lgtmoose/provider/*`, and `secretsmanager:ListSecrets`, which can't be limited to a resource
- For `auth bedrock`: `bedrock:ListFoundationModels`, `bedrock:GetFoundationModelAvailability` and `bedrock:ListInferenceProfiles`. Model aliases such as `sonnet` are only hinted at: Claude Code picks the model at runtime, so pin model ids in `models` to have them checked

`auth` stores each provider's credential as `lgtmoose/provider/<id>`. See [docs/credentials.md](docs/credentials.md).

### Upgrading

```bash
git pull && pnpm install && pnpm lgtmoose deploy
```

### Removing it

`pnpm lgtmoose destroy` deletes the stacks. It keeps a final snapshot of the database, the secret that unlocks it and the artifact bucket. `pnpm lgtmoose destroy --purge` deletes those too, after redeploying the Data stack from your checkout to change what deletion keeps; the database's CloudWatch logs expire on their own. Neither touches the GitHub App or its secrets.

One AWS account and region holds one install for now, because the secret and stack names are fixed. Put a second install, such as staging, in another account or region.

### How a review runs

Each review job is one execution of the review state machine (`StateMachineArn` in the Workflow stack's outputs):

1. **Prepare** (control task): records the run, clones and plans the PR, and uploads the checkout and each batch's input to `runs/<run id>/` in the artifact bucket. A run for a head that's no longer the PR's head stops here as superseded.
2. **Batches** (sandbox tasks, `maxConcurrency` at once): each runs the reviewer on one batch. Sandbox tasks have no S3 access of their own; a small Lambda hands each one presigned URLs for its own batch.
3. **Post** (control task): reads the batches' outputs and posts one review, the check run, the summary comment and the status label. A batch without a valid output makes the review incomplete, so it can't approve.

A step that fails for good marks the run failed and posts nothing more: a failure before post leaves the PR untouched. With `shadow: true` in `lgtmoose.config.ts` (the default for now), post records what it would post to `shadow/` in the bucket and the log instead.

## Repository layout

```
apps/cli/        lgtmoose CLI (setup · auth · deploy · destroy · review --dry-run)
apps/control/    control task: prepares batches and posts results; holds the GitHub App
apps/sandbox/    sandbox task: runs a model on one batch; one model credential, no GitHub token
apps/egress-proxy/ the sandbox's only way out: CONNECT proxy with an exact-host allowlist
packages/core/   pure domain logic: findings, fingerprints, decision
packages/git/    local checkouts: clone at a SHA, review diffs, comment positions
packages/harness/ agent CLIs run headless on one batch: read-only tools, zod-checked JSON
packages/evals/   eval fixtures, scores and the recall gate for prompt and harness changes
packages/pipeline/ one whole review in-process, without posting (review --dry-run, evals)
packages/planner/ what to review and in what order: skips, risk tiers, batches, reading depth
packages/roles/  agent roles: reviewer prompt, rule packs, untrusted-text wrapping
packages/poster/  posts a run: one review, inline comments, check run, summary, labels
packages/summary/ the PR summary comment and status label sync
infra/cdk/       AWS CDK app
infra/sandbox/   the sandbox image: pinned agent CLIs
deploy/compose/  docker compose deployment for hosts other than AWS
docs/            architecture and design notes
```

## Development

Requires Node 24 and pnpm 10.

```bash
pnpm install
pnpm run check   # format, lint, typecheck, test, build, run the built CLI, cdk synth
```

The migration runner also has an integration test against a real Postgres with pgvector (`test:integration`). CI always runs it; locally it runs when `LGTMOOSE_TEST_DATABASE_URL` points at an admin connection:

```bash
pnpm db:test:start   # the same pinned image as CI, from tools/test-postgres/Dockerfile
LGTMOOSE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm turbo run test:integration
```

## Roadmap

1. **M1:** skeleton in shadow mode: setup wizard, CDK stacks, gateway, first reviewer, `review --dry-run`
2. **M2:** Step Functions workflow, sandbox tasks, deterministic decision and posting
3. **M3:** providers: Codex, Cursor, Bedrock, API keys, credential broker, fallback chain
4. **M4:** quality: parallel batches, cross-file pass, verifier, evals
5. **M5:** conversation and learning: reply judge, commands, learnings, dashboard
6. **M6:** public release v0.1.0

See [docs/architecture.md](docs/architecture.md).

## License

[Apache-2.0](LICENSE)
