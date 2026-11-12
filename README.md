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
pnpm lgtmoose deploy    # cdk deploy, then prints the App install link
```

One AWS account and region holds one install for now, because the secret and stack names are fixed. Put a second install, such as staging, in another account or region.

## Repository layout

```
apps/cli/        lgtmoose CLI (setup · auth · deploy · destroy · review --dry-run)
packages/core/   pure domain logic: findings, fingerprints, decision
infra/cdk/       AWS CDK app
deploy/compose/  docker compose deployment for hosts other than AWS
docs/            architecture and design notes
```

## Development

Requires Node 24 and pnpm 10.

```bash
pnpm install
pnpm run check   # format, lint, typecheck, test, build, cdk synth
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
