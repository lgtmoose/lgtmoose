# Upgrading

LGTMoose hasn't cut a release yet: you upgrade your checkout and deploy it again. Once releases exist, you can also check out a release's tag and deploy its published images (see [Releasing](releasing.md)); `deploy` warns when your checkout is older than the latest release.

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

- **Waiting for CI notices a check suite and a commit status, not each check run.** `review.wait_for_checks` (see [Waiting for CI](commands.md#waiting-for-ci)) reads the PR's check runs and commit statuses. A new App from `lgtmoose setup` subscribes to **Check suite** and **Status**, and **Commit statuses** is read-only. It does not subscribe to **Check run**: one suite is one event per workflow, and a run is one event per job. For an App made before, in its settings on GitHub (Settings, Developer settings, GitHub Apps, your App, Permissions & events): set **Commit statuses** to read-only, subscribe to **Check suite** and **Status**, and drop **Check run**. Then each installation's owner accepts the new permission on the installation's page. An App that still sends check runs is ignored. Until Status is subscribed, CI that only sets commit statuses is noticed by the reconciler, at its interval. A named check that passes while other jobs in the same suite are still running is noticed when that suite completes, or by the reconciler within five minutes. A different suite completing still wakes the wait. Repositories that don't set `wait_for_checks` are unaffected.

- **The images no longer contain npm.** The control, egress proxy and sandbox images drop npm, npx, corepack and yarn from their final stage, which removed advisories in npm's bundled packages. The sandbox's agent CLIs are installed at build time and still run. If you added your own steps to these Dockerfiles that call npm at runtime, install what you need in the build stage instead.
- **Config keys.** New keys always have defaults. A removed or renamed key fails `deploy` with its path, so you can fix `lgtmoose.config.ts` before anything changes. The [configuration reference](configuration.md) lists every key.
- **`standard` uses RDS PostgreSQL, not Aurora.** The `standard` profile used to create Aurora Serverless v2. It now uses the same RDS instance as `lean` (see [Switching profile](#switching-profile)). A deployment that already runs `standard` on Aurora can't be updated in place: CloudFormation would refuse to change the database's resource type. Stay on the older version, or move the data with a snapshot and restore first. No `standard` deployment is known to exist yet.
- **Alarms can notify you.** Set `alarms.email` (LGTMoose creates an SNS topic and subscribes the address; confirm the email AWS sends) or `alarms.topicArn` (an existing topic). Every alarm in every stack then notifies it.
- **Release images.** `images: { source: "release", … }` deploys a release's published images, pinned by digest, instead of building them. The default, `build`, is unchanged. See [Releasing](releasing.md#deploying-a-release).
- **Shadow mode.** `shadow: true` is the default. Upgrading never turns it off; set `shadow: false` yourself when you want reviews posted.

## Switching profile

Change `profile` in `lgtmoose.config.ts` and run `pnpm lgtmoose deploy`. Both profiles use the same RDS PostgreSQL instance, so the database is modified in place and keeps its data:

- **`lean` → `standard`**: the instance grows from `db.t4g.micro` to `db.t4g.small`, gains a Multi-AZ standby, and keeps 14 days of backups instead of 7. The NAT instance is replaced by a NAT gateway in each AZ, the sandbox subnet and VPC endpoints spread to both AZs, the proxy runs two tasks, logs are kept longer, and the standard alarms are added.
- **`standard` → `lean`**: the reverse. Logs already older than the shorter retention are deleted.

What to expect:

- **A short database outage.** RDS applies the class change during the deploy, not in the next maintenance window. The database restarts, which takes a few minutes; adding the Multi-AZ standby doesn't stop it. Reviews that hit the restart fail and are retried on the next push or by the reconciler. Switch outside busy hours.
- **NAT and endpoints are replaced, not modified.** They hold no data. Outbound traffic from the app subnets and the sandbox pauses briefly while the new ones come up.
- **Nothing is replaced that holds data.** The database, its subnet group, its parameter group and the artifact bucket keep their CloudFormation logical IDs, and none of the properties that would make CloudFormation replace the database (engine, database name, encryption, master user, subnet group) differ between the profiles. `infra/cdk/lib/data-stack.test.ts` checks this. The database is also snapshotted if CloudFormation ever deletes or replaces it, and deletion protection stays on.

Before switching, you can check for yourself: `pnpm --filter @lgtmoose/cdk exec cdk diff Lgtmoose-Data` should list the database as modified, never as `[-]` destroyed or `requires replacement`.

**Aurora isn't offered.** Earlier versions planned Aurora Serverless v2 for `standard`. Aurora is a different resource type (`AWS::RDS::DBCluster`), which CloudFormation can only switch to by deleting the instance and creating a new, empty cluster, so a profile switch would have lost data. Moving to Aurora would need a snapshot and restore; that isn't scripted.

## Going back

To go back to an earlier version, check out that commit and deploy it. Migrations aren't rolled back, so an older version runs against the newer schema. That works as long as the older code doesn't depend on something a later migration removed, which no migration has done so far.

## Removing it

`pnpm lgtmoose destroy` deletes the stacks. It keeps a final snapshot of the database, the secret that unlocks it and the artifact bucket. `pnpm lgtmoose destroy --purge` deletes those too, after redeploying the Data stack from your checkout to change what deletion keeps; the database's CloudWatch logs expire on their own. Neither touches the GitHub App or its secrets.
