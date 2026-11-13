# @lgtmoose/evals

Runs the review pipeline (the one behind `lgtmoose review --dry-run`) on fixtures and scores what it would post.

## Fixtures

Each directory under `fixtures/` is one PR:

- `base/`: the repository before the PR.
- `head/` (optional): files the PR adds or changes, laid over `base/`.
- `fixture.json`:
  - `title`, `body`: the PR's text.
  - `kind`: `seeded` (has bugs to find) or `clean` (has none).
  - `expected`: the seeded bugs. Each has a `category` (one rule category, or a list of acceptable ones), a `path`, `lines` (`[start, end]` on the head side) and a `severity`.
  - `mustNotFlag`: code the reviewer must leave alone. Each has a `path`, and optionally `lines` and `categories`.
  - `deleted`: files the PR deletes.

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

In CI, `.github/workflows/evals.yml` runs this on PRs that touch prompts, rule packs, harnesses, the pipeline or the evals. It needs an `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` repository secret, and skips without one.
