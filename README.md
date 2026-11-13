# LGTMoose 🫎

A self-hosted, open-source AI pull request reviewer. Fork it, deploy it to your own AWS account with one command, and teach it by tagging `@lgtmoose` in review comments.

> **Status: pre-alpha.** Nothing here reviews code yet. Follow the roadmap below.

## What it will do

- **Review every PR** as a GitHub App: inline comments, a summary, a status label and a required check run.
- **Learn from your team.** `@lgtmoose learn: …` and declined findings become scoped learnings, stored in your database and synced back to the repo for review.
- **Run on the model access you already have**: Amazon Bedrock, Anthropic or OpenAI API keys, or Claude, ChatGPT and Cursor plan credentials where the vendor's terms allow it. Different providers can do different jobs, and it falls back to the next one when a plan runs out.
- **Stay in your account.** The model runs in a sandbox with no GitHub token and network access only to its model API. Plain code, not the model, posts reviews, decides and writes memory.

## Quickstart (planned)

```bash
git clone https://github.com/lgtmoose/lgtmoose && cd lgtmoose && pnpm install
pnpm lgtmoose setup     # creates the GitHub App, stores its keys in AWS Secrets Manager
pnpm lgtmoose auth bedrock   # or: claude · codex · cursor · api-key
pnpm lgtmoose deploy    # cdk bootstrap (first time) and deploy, points the App's webhook at the gateway, prints the install link
```

`deploy` uses your current AWS credentials (for example `aws sso login` or `AWS_PROFILE`) and the region in `lgtmoose.config.ts`. Administrator access is simplest. A scoped role needs to assume the CDK bootstrap roles and create the bootstrap stack, plus the calls the CLI makes itself:

- `sts:GetCallerIdentity`
- `cloudformation:DescribeStacks`
- `secretsmanager:GetSecretValue`, `CreateSecret` and `PutSecretValue` on `lgtmoose/*` (setup writes them)
- `rds:DescribeDBInstances`, `DescribeDBClusters`, `ModifyDBInstance`, `ModifyDBCluster`, `StartDBInstance` and `StartDBCluster` (deploy checks the database's deletion protection, and destroy turns it off)

### Upgrading

```bash
git pull && pnpm install && pnpm lgtmoose deploy
```

### Removing it

`pnpm lgtmoose destroy` deletes the stacks. It keeps a final snapshot of the database, the secret that unlocks it and the artifact bucket. `pnpm lgtmoose destroy --purge` deletes those too, after redeploying the Data stack from your checkout to change what deletion keeps; the database's CloudWatch logs expire on their own. Neither touches the GitHub App or its secrets.

One AWS account and region holds one install for now, because the secret and stack names are fixed. Put a second install, such as staging, in another account or region.

## Repository layout

```
apps/cli/        lgtmoose CLI (setup · auth · deploy · destroy · review --dry-run)
packages/core/   pure domain logic: findings, fingerprints, decision
packages/git/    local checkouts: clone at a SHA, review diffs, comment positions
packages/planner/ what to review and in what order: skips, risk tiers, batches, reading depth
packages/roles/  agent roles: reviewer prompt, rule packs, untrusted-text wrapping
infra/cdk/       AWS CDK app
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
