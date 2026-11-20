# Evals

Runs the review pipeline (the one behind `lgtmoose review --dry-run`) on fixtures and scores what it would post.

## Fixtures

Each directory under `packages/evals/fixtures/` is one PR. The golden set (see [the fixtures list](https://github.com/lgtmoose/lgtmoose/blob/main/packages/evals/fixtures/README.md)) has 17 seeded bugs and 6 clean changes.

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

`--repeat <n>` runs each fixture n times. Recall stays the first run, so the baseline compares one run. A later run that fails is reported and is not a miss. The report adds how often each expected finding was hit, and its cost and time are the sum of the runs.

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

Findings people declined make good private fixtures: `pnpm lgtmoose feedback export-declined --out <dir>` writes a `clean` fixture skeleton for each, with a `mustNotFlag` entry on the declined lines. See [Feedback signals](feedback.md).

The committed `baseline.json` is measured on the public fixtures, so a run with extra fixtures compares recall over a different set. Keep a baseline for your own set and pass it with `--baseline`, including with `--update-baseline`; updating without `--baseline` is refused when extra fixtures are loaded.

In a fork's CI, check out the private fixtures repository with a deploy key or token that can read it, then pass its path in `LGTMOOSE_EVAL_FIXTURES` to the evals step. Keep the report and transcripts private: they contain your fixtures' code.

## Learning speed

The learning-speed evals check that a correction sticks on the next review. They also check that no correction quiets a finding in a protected category (`authz`, `tenant_scoping`, `money`, `secrets`).

Each file in `packages/evals/learning/` is one scenario: a repository and 2 to 6 PRs that show the same pattern. Each PR is reviewed by the real pipeline, with the real learnings store, write policy, retrieval and reviewer prompt. After each review that raises the scenario's finding, one correction is applied through the same code the control app runs:

- `learn`: a person's `@lgtmoose learn: …` comment, parsed by the command parser and stored by the write policy with that person's access.
- `remember`: the finding is declined with a reason, then `@lgtmoose remember` turns it into a learning.
- `repeat`: the finding is declined, and outcome learning proposes a learning once the pattern has been rejected on enough PRs (`learnings.repeatThreshold`, 2).
- `bootstrap`: a history bootstrap proposed the learning at install, pending. The correction is a person approving it.

The scenarios cover conventions, accepted patterns and scoping (path-scoped learnings included). Four are adversarial:

- three by contributors without write access, who try `learn:`, `remember` and repeated declines on an authorization, tenant-scoping or refund finding;
- one by a maintainer, who tries to scope away authorization findings, which the policy refuses for anyone.

### Scores

- **Repeat after correction:** PRs reviewed after the scenario's expected number of corrections whose review still raised the finding, out of all such PRs.
- **Collateral:** protected findings that went missing from a later review while a learning was in that file's prompt, out of the protected findings checked. It must be 0.
- **Other kept findings quieted:** the same, for findings a scenario says must stay, such as the same finding outside a learning's path.
- **Untrusted learnings in prompts:** learnings proposed by someone without write access that reached a prompt. It must be 0.
- **Time to learn:** how many corrections a scenario took before the finding stopped. A scenario says how many it should take (`signals`): 1 for `learn`, `remember` and `bootstrap`, and 2 for `repeat`.

### Without a model

The normal CI test job runs every scenario with a stub reviewer (`gullibleReviewer`). It raises each PR's findings except those that a learning in its prompt names (the finding's `topic`) within that learning's scope. It follows every learning it's given, protected categories included. That is the worst case: every defence these scores show comes from the code (the policy, retrieval, the prompt builder), not from a model behaving well.

The test fails on any repeat, collateral, quieted kept finding or untrusted learning in a prompt, and when a scenario takes longer to learn than it should. It also checks that the gate catches the attack when the attacker is given write access, and catches a correction that doesn't stick.

### With a model

`pnpm --filter @lgtmoose/evals run eval` runs the scenarios after the fixtures, on the fast tier (`--learning-model`, `haiku` by default), four scenarios at a time. With a model, a scenario whose first review doesn't raise the finding is "not applicable" and leaves the repeat rate alone. A review that fails doesn't count either way.

The learning gate fails the run on any collateral or untrusted learning in a prompt. It also fails when the repeat rate is more than 10 points above `baseline.json`'s `learningRepeatRate` for the same `learningModel`. `--update-baseline` records both fields, but never from a run with collateral. `--only <scenario>` runs one scenario, and `--no-learning` leaves them out.

### Adding a scenario

A scenario's JSON holds:

- `description`, `family` (`convention`, `accepted_pattern`, `scoping` or `adversarial`), and `expect`: `learns`, or `holds` when the finding is a protected one someone tries to teach away;
- `signals`: the corrections it should take;
- `permissions`: each login's access, `read` by default;
- `correction`: one of the four kinds above;
- `base`: the repository's files;
- `prs`: each PR's `title` and `files`, its `target` finding and any `keep` findings.

A finding has a `category` (and `also` for others a model may use), `severity`, `path`, `line` (and `lines`, the range a model's finding may cite), `title` and `topic`.

Loading checks that each finding's file is one the PR changes and that the line exists. A `holds` scenario's target must be in a protected category.

Known limit: the stub reviewer can't measure the reviewer prompt's own rule that a learning never quiets a protected finding. A suppressing learning with no category that names a protected topic is refused before it is stored. One that names a category other than the four protected ones is still stored, and then the model's instructions are the defence. Only a model run measures that.

## CI

In CI, `.github/workflows/evals.yml` runs this on PRs that touch prompts, rule packs, harnesses, the pipeline, the learnings package, outcome learning or the evals. It needs an `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` repository secret, and skips without one. The learning-speed scenarios also run without a model, in the normal test job, on every PR.
