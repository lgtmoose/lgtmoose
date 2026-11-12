# Contributing to LGTMoose

Thanks for helping. LGTMoose is pre-alpha, so expect things to move.

## Setup

1. Install Node 24 (`nvm use`) and pnpm 10 (`corepack enable`).
2. `pnpm install`
3. `pnpm run check` runs format, lint, typecheck, tests, build and `cdk synth`. CI runs the same.

## Pull requests

- Keep PRs focused on one change and describe what changed and why.
- Add or update tests for behaviour changes. Logic in `packages/core` should stay pure and fully tested.
- No HTTP `PATCH` routes or clients: use `PUT`.
- No nested ternaries.
- Never commit secrets, tokens or real customer data, including in test fixtures.

## Changing prompts or rule packs

Changes to prompts, rule packs or harnesses must keep eval recall at or above the baseline. CI reports this once the eval harness lands.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
