# @lgtmoose/evals

Runs the review pipeline (the one behind `lgtmoose review --dry-run`) on fixtures and scores what it would post.

## Fixtures

Each directory under `fixtures/` is one PR. The golden set (see [fixtures/README.md](fixtures/README.md)) has 17 seeded bugs and 6 clean changes.

- `base/`: the repository before the PR.
- `head/` (optional): files the PR adds or changes, laid over `base/`.
- `fixture.json`:
  - `title`, `body`: the PR's text.
  - `kind`: `seeded` (has bugs to find) or `clean` (has none).
  - `expected`: the seeded bugs. Each has a `category` (one rule category, or a list of acceptable ones), a `path`, `lines` (`[start, end]` on the head side) and a `severity`.
  - `mustNotFlag`: code the reviewer must leave alone. Each has a `path`, and optionally `lines` and `categories`.
  - `deleted`: files the PR deletes.
  - `tags` (optional): labels for the report, such as `cross-file` for bugs only a pass over the whole PR can see. The report shows recall per tag.

Loading a fixture checks it: every expected and protected range must exist in its file, each expected bug must be in a file the PR changes (findings can only be posted on the diff), and deleted files must be in the base.

A finding matches an expected bug when its path is the same, its cited lines overlap, and its category is one of the expected ones. Severity is scored separately. A blocking or should-fix finding on protected code, or anywhere on a clean fixture, is a false positive. Nits never count as false positives.

## Scores

- **Recall:** seeded bugs found, out of all seeded bugs.
- **False-positive rate:** clean fixtures with a false positive, out of all clean fixtures.
- **Severity accuracy:** matched findings with the expected severity.
- **Cost and time:** totals for the run.

A fixture run that fails counts as finding nothing.

## Running

You need a model credential in the environment, as for the dry run.

```bash
pnpm turbo run build --filter @lgtmoose/evals...
```

```bash
pnpm --filter @lgtmoose/evals run eval --out /tmp/evals
```

The run writes `report.md` and `report.json`, and exits 1 when recall is more than 5 points below `baseline.json`.

After a change that's meant to move the numbers, run it with `--update-baseline` and commit `baseline.json`. The committed baseline starts at 0, because no real run has been measured yet, so the gate passes until the first one is.

## Provider matrix

To compare providers on the same fixtures, name them with `--providers`:

```bash
pnpm evals --providers claude,chatgpt,cursor
```

`pnpm evals` builds the package and runs it from the repository root. Each provider reviews every fixture in turn:

| Provider    | Runs                         | Credential (from the environment)                                                                  |
| ----------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `claude`    | Claude Code (`claude -p`)    | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, Bedrock or Vertex                                  |
| `agent-sdk` | the Claude Agent SDK         | `ANTHROPIC_API_KEY`, Bedrock or Vertex (not a claude.ai sign-in)                                   |
| `chatgpt`   | the Codex CLI (`codex exec`) | `CODEX_AUTH_JSON` (a ChatGPT sign-in), `CODEX_ACCESS_TOKEN`, or `CODEX_API_KEY` / `OPENAI_API_KEY` |
| `cursor`    | the Cursor CLI (`agent`)     | `CURSOR_API_KEY`                                                                                   |

A provider without a credential is skipped, and the table says why. A rate or plan limit fails that batch: it's counted under "Limit hits", and the run goes on.

- `--roles reviewer=claude` sets a provider per role, one configuration per flag (repeatable). Only the reviewer can be set today: the cross-file pass and the verifier have prompts but no step that runs them yet, so the flag refuses them rather than report numbers for a role that didn't run.
- `--model chatgpt=gpt-5-codex` sets one provider's model (repeatable). A bare `--model opus` is Claude Code's, as before. Without one, Claude Code runs `sonnet` and the others their own default.
- `--claude`, `--codex` and `--cursor` point at the binaries when they aren't on `PATH`.

A matrix run isn't gated on the baseline. It writes to `--out` (default `./eval-report`, which git ignores):

- `matrix.md`: the side-by-side table, with recall, false-positive rate, cost, time, limit hits and failed runs per configuration.
- `matrix.json`: the same numbers per configuration and per fixture, with no finding text. It's versioned (`matrixResultsSchema`), so runs kept with `--results <dir>`, which adds a timestamped copy there, can be read back when choosing role defaults.
- A folder per configuration with its `report.md`, `report.json` and transcripts.

It exits 2 when no configuration could run (no credentials), and 0 otherwise.

## Private fixtures

A fork can keep fixtures from its own code outside this repository and run them with the public ones. Put them in a directory with the same layout as `fixtures/`, for example a private repository checked out next to this one, and pass it with `--fixtures` (repeatable) or `LGTMOOSE_EVAL_FIXTURES` (directories separated by `:`, or `;` on Windows):

```bash
pnpm --filter @lgtmoose/evals run eval --fixtures ../acme-eval-fixtures --out /tmp/evals
```

Add `--no-public` to run only your own. Fixture names must be unique across all directories.

The committed `baseline.json` is measured on the public fixtures, so a run with extra fixtures compares recall over a different set. Keep a baseline for your own set and pass it with `--baseline`, including with `--update-baseline`; updating without `--baseline` is refused when extra fixtures are loaded.

In a fork's CI, check out the private fixtures repository with a deploy key or token that can read it, then pass its path in `LGTMOOSE_EVAL_FIXTURES` to the evals step. Keep the report and transcripts private: they contain your fixtures' code.

## CI

In CI, `.github/workflows/evals.yml` runs this on PRs that touch prompts, rule packs, harnesses, the pipeline or the evals. It needs an `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` repository secret, and skips without one.
