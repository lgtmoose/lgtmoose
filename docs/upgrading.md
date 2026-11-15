# Upgrading

LGTMoose has no release channel yet: you upgrade your checkout and deploy it again.

```bash
git pull
```

```bash
pnpm install
```

```bash
pnpm lgtmoose deploy
```

`deploy` rebuilds the container images and updates every stack in place. Your `lgtmoose.config.ts`, the GitHub App, its secrets and the provider credentials are left as they are. If you've forked the repository, merge upstream into your fork first, and keep your own changes (private rule packs, say) in their own files.

## What happens during a deploy

The stacks deploy in dependency order:

1. `Lgtmoose-Meta`, `Lgtmoose-Network` and `Lgtmoose-Data`.
2. Inside `Lgtmoose-Data`, **database migrations** run as a custom resource whenever a file in `packages/db/migrations` changed. They finish before any stack that reads the database is updated.
3. `Lgtmoose-Api` (the gateway) and `Lgtmoose-Proxy` (the egress proxy).
4. `Lgtmoose-Workflow`: the review state machine, the dispatcher, the conversation Lambda, the reconciler, the credential broker and the task definitions.
5. Finally, `deploy` points the GitHub App's webhook at the gateway's URL.

Migrations only add to the schema, so a review that's running while the Data stack updates keeps working; it finishes on the old code. A failed migration fails the Data stack's update, and CloudFormation rolls it back before anything that depends on it changes.

## Notes for specific changes

- **The images no longer contain npm.** The control, egress proxy and sandbox images drop npm, npx, corepack and yarn from their final stage, which removed advisories in npm's bundled packages. The sandbox's agent CLIs are installed at build time and still run. If you added your own steps to these Dockerfiles that call npm at runtime, install what you need in the build stage instead.
- **Config keys.** New keys always have defaults. A removed or renamed key fails `deploy` with its path, so you can fix `lgtmoose.config.ts` before anything changes. The [configuration reference](configuration.md) lists every key.
- **Shadow mode.** `shadow: true` is the default. Upgrading never turns it off; set `shadow: false` yourself when you want reviews posted.

## Going back

To go back to an earlier version, check out that commit and deploy it. Migrations aren't rolled back, so an older version runs against the newer schema. That works as long as the older code doesn't depend on something a later migration removed, which no migration has done so far.

## Removing it

`pnpm lgtmoose destroy` deletes the stacks. It keeps a final snapshot of the database, the secret that unlocks it and the artifact bucket. `pnpm lgtmoose destroy --purge` deletes those too, after redeploying the Data stack from your checkout to change what deletion keeps; the database's CloudWatch logs expire on their own. Neither touches the GitHub App or its secrets.
