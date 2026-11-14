# Golden fixtures

Small repositories, each with one pull request, that the evals run the review pipeline on. Every
fixture was written for LGTMoose: no third-party code is copied in, and they are licensed under
the repository's [Apache License 2.0](../../../LICENSE), like the rest of the code.

The code in them is data, not part of the build: it isn't type-checked, linted, formatted or
tested with the repository, and the line numbers in each `fixture.json` depend on it staying
exactly as it is. Edit a fixture's files and its `fixture.json` together.

## Seeded bugs

| Fixture | Bug | Category | Severity |
| --- | --- | --- | --- |
| `cents-vs-dollars` | A shipping fee in dollars added to an amount in cents | correctness | blocking |
| `ci-wrong-working-directory` | A new CI step runs `npm test` at the repo root instead of `web/` | wiring | blocking |
| `double-charge-on-retry` | A timed-out charge is retried without an idempotency key | correctness | blocking |
| `env-var-undefined` | A required setting nothing defines in deploy config or `.env.example` | wiring | blocking |
| `missing-auth-middleware` | A new admin route without `requireAdmin` | authz | blocking |
| `missing-authz` | Cancelling an order without checking who owns it | authz | blocking |
| `nested-ternary-nit` | A nested ternary the repo's `CLAUDE.md` forbids | convention | nit |
| `nosql-operator-injection` | A request body value used as a MongoDB query value | security | blocking |
| `off-by-one` | A loop bound that skips the last item | correctness | blocking |
| `path-traversal-download` | A file name from the query string joined into a path | security | blocking |
| `secret-in-log` | Request headers with the API key written to the log | secrets | blocking |
| `sql-injection-search` | Search text built into an SQL string | security | blocking |
| `swallowed-error` | A failed email ignored, and the invoice marked sent anyway | error_handling | should_fix |
| `tenant-filter-missing` | A lookup by id with no tenant filter | authz | blocking |
| `unawaited-write` | A settings write that isn't awaited | correctness | should_fix |
| `unused-new-export` | A new export meant for the jobs list that nothing calls | wiring | should_fix |

Fixtures tagged `cross-file` (`ci-wrong-working-directory`, `env-var-undefined`,
`unused-new-export`) hold bugs that show up only when reading files the PR didn't change. The
cross-file pass is built for them; the report shows their recall separately.

## Clean changes

`clean-config-change`, `clean-docs`, `clean-extract-helper`, `clean-rename`,
`clean-safe-migration` and `clean-tested-pagination` are correct changes. Any blocking or
should-fix finding on them is a false positive.

## Adding a fixture

1. Make a directory with `base/` (the repository before the PR), `head/` (only the files the PR
   adds or changes) and `fixture.json` (see the package README for the format).
2. Keep it small: a handful of files, one clear bug, and `mustNotFlag` entries on the nearby
   correct code so a careless reviewer shows up as false positives.
3. Run the package's tests. They check that every expected and protected range exists, that each
   expected bug is in a file the PR changes, and that a perfect reviewer would score 100% on it.
