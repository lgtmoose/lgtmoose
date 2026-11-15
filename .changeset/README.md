# Changesets

LGTMoose has one version: the version of the `lgtmoose` package (`apps/cli`). Every release is
tagged `v<that version>`. The other workspace packages are private parts of the same product and
stay at `0.0.0`, so a changeset always names `lgtmoose` and nothing else.

Add one with every pull request that changes code under `apps/`, `packages/` or `infra/`:

```bash
pnpm changeset
```

Pick `lgtmoose`, choose patch, minor or major, and write one or two sentences for the changelog,
in the words of someone who runs LGTMoose. For a change nobody running it would notice (tests,
refactors, CI), add an empty one instead:

```bash
pnpm changeset --empty
```

CI checks this (`tools/release/check-changesets.mjs`). See [docs/releasing.md](../docs/releasing.md)
for how changesets become a release.
