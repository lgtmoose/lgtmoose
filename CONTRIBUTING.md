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

## Editors and TypeScript

The repo uses TypeScript 7, the native compiler. Its package has no JavaScript API and no `tsserver`, so don't point your editor at the workspace TypeScript version (in VS Code, "Use Workspace Version"). Use TypeScript 7's native language server, or your editor's bundled TypeScript. A tool that loads the compiler API (`require("typescript")`) won't work either; add a separate TypeScript 5 or 6 alias for it if one is ever needed.

## Dependency updates

Dependabot opens weekly PRs for npm packages, GitHub Actions and the test Postgres image. A bump of a third-party action (one not under `actions/`) runs with CI's tokens and can write to the shared turbo cache, so read the action's diff between the two pinned commits before merging. Don't merge it as routine.

## Changing prompts or rule packs

Changes to prompts, rule packs or harnesses must keep eval recall at or above the baseline. CI reports this once the eval harness lands.

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).
