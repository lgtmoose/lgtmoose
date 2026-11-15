# Feedback signals

LGTMoose keeps track of how often people accept its findings, per rule category, so you can see
which rules are worth their noise. These are signals only: nothing changes a decision, a
severity or a rule on its own.

## What's recorded

- **Reactions.** 👍 and 👎 on LGTMoose's inline comments, in the `feedback` table. GitHub sends no
  webhook for reactions on review comments, so the reconciler reads them with the REST API on its
  schedule. It reads at most `feedback.maxCommentsPerRun` comments per run (100 by default), the
  least recently checked first, and only on findings raised in the last 30 days. Each person
  counts once per comment, with their latest 👍 or 👎. Bots, LGTMoose included, don't count. A
  removed reaction or a deleted comment is removed on the next read.
- **Outcomes.** What became of each finding: fixed, declined, disputed, resolved by a person,
  outdated or still open. These come from the review workflow and the reply judge.

## Acceptance

Over findings raised in the last 90 days, each finding counts as:

- **accepted** when it was fixed, or nobody declined or disputed it and it has more 👍 than 👎;
- **rejected** when it was declined or disputed, or it wasn't fixed and has more 👎 than 👍;
- **neither** otherwise: still open, outdated, resolved without a word, or as many 👍 as 👎.

A category's acceptance is accepted ÷ (accepted + rejected), once it has `feedback.minSamples` of
those (10 by default). A category below `feedback.acceptanceThreshold` (0.5 by default) is
**flagged** for a person to look at. Protected categories (`authz`, `tenant_scoping`, `money`,
`secrets`) are never demoted, only flagged with a note.

```ts
// lgtmoose.config.ts
feedback: { acceptanceThreshold: 0.5, minSamples: 10, maxCommentsPerRun: 100 },
```

## The report

Each reconciler run writes the report to the artifact bucket (`reports/feedback/latest.json`) and
logs `FeedbackCommentsRead` and `CategoriesFlagged` as CloudWatch metrics in the `LGTMoose`
namespace. Each flagged category also gets a log line. The reconciler's role may write that one
key and nothing else in the bucket.

```bash
pnpm lgtmoose feedback report
```

```bash
pnpm lgtmoose feedback report --json
```

The JSON is `feedbackReportSchema` in `@lgtmoose/core`, which the [dashboard](dashboard.md)'s acceptance page shows.

## Declined findings as eval fixtures

```bash
pnpm lgtmoose feedback export-declined --out ./declined --repo acme/shop --limit 20
```

This writes a `clean` eval fixture skeleton for each declined finding the report lists (up to 200,
newest first): `fixture.json` with a `mustNotFlag` entry on the declined lines and category, and
the file at the commit the finding was raised on (`head/`) and at the PR's base (`base/`). It runs
on your machine: the report comes from S3 with your AWS credentials, and the code from GitHub with
`GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`. No code is stored in the database or the report.

The fixtures hold your repository's code. Review each one, tighten its lines, and only add it to a
fixture set where that code may be published. Findings on removed lines are skipped, and existing
files are never overwritten.
