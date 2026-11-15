# Releasing

LGTMoose has one version, the `lgtmoose` package's (`apps/cli/package.json`). A release is a
`v<version>` tag, the control, egress proxy and sandbox images published to GHCR, and a GitHub
release that lists each image's digest. No release has been cut yet.

## How changes become a release

1. **Every pull request** that changes code under `apps/`, `packages/` or `infra/` adds a
   changeset: `pnpm changeset`, naming `lgtmoose` with a patch, minor or major bump and a line or
   two for the changelog. A change nobody running LGTMoose would notice gets an empty one,
   `pnpm changeset --empty`. The release workflow's changeset check enforces this, and only
   `lgtmoose` may be named (see `.changeset/README.md`).
2. **On `main`**, the release workflow opens or updates a "Version packages" pull request. It
   applies the pending changesets: it bumps `apps/cli/package.json` and writes
   `apps/cli/CHANGELOG.md`. Merging it publishes nothing.
3. **The owner tags the release** when it's ready (the checklist below), and pushes the tag. That
   is the only thing that publishes.

**Why one version:** LGTMoose is deployed as a whole, from one checkout, and its packages are
private: nobody installs `@lgtmoose/core` on its own. One version answers "what am I running?"
in one word, and a tag names exactly the code and images that go together.

## What a tag does

For each image, on `ubuntu-latest`, building linux/arm64 under emulation (deployments run on
arm64):

1. Checks the tag matches `apps/cli/package.json`'s version.
2. Builds the image and checks it starts (read-only, as in a task): the control image runs node
   and git, the proxy runs node, the sandbox runs `claude` and `codex`. None of them has npm.
3. Scans it with Trivy. A fixable high or critical vulnerability fails the release, and nothing is
   pushed. Accepted ones are in `.trivyignore`, each with a reason and an expiry.
4. Pushes it to `ghcr.io/<owner>/lgtmoose-<image>:<tag>` with an SBOM and BuildKit provenance,
   and adds a GitHub build provenance attestation.

Then it creates the GitHub release: the changelog section, a table of digests, the
`gh attestation verify` commands, and the `images` config that deploys exactly those images.

**The sandbox image has no Cursor CLI.** Its checksum for linux/arm64 isn't recorded yet
(`CURSOR_AGENT_SHA256` in `packages/harness/src/version.ts`), so a published image would have to
install it unverified. The config refuses `cursor-agent` with release images; deploy from a build
to use it.

Pull requests that change `.github/workflows/release.yml` or `tools/release/` run steps 2 and 3
as a dry run, without logging in, pushing or attesting.

## Deploying a release

Building from the checkout stays the default (`images: { source: "build" }`). To deploy a
release's images instead:

1. Check out the release's tag, so the CDK app and the images match.
2. Verify each image (it checks the image was built by this repository's release workflow from
   that tag):

   ```bash
   gh attestation verify oci://ghcr.io/lgtmoose/lgtmoose-control@sha256:… --repo lgtmoose/lgtmoose
   ```

3. Set `images` in `lgtmoose.config.ts` as the release notes show:

   ```ts
   images: {
     source: "release",
     version: "0.1.0",
     digests: { control: "sha256:…", sandbox: "sha256:…", egressProxy: "sha256:…" },
   },
   ```

4. `pnpm lgtmoose deploy`.

Images are pinned by digest, never by tag: a tag can be moved after you verified it, a digest
can't. CDK turns each one into an image asset whose Dockerfile is only `FROM <image>@<digest>`,
which Docker pulls on your machine and CDK pushes to your account's ECR, as it does for built
images. So tasks pull from ECR, and the sandbox subnet keeps its no-internet rule: its only
routes are the VPC endpoints. Docker still has to run during a deploy, but nothing is compiled.

`lgtmoose deploy` checks GitHub's public API for the latest release and warns when your checkout
is older. It never stops a deploy, and says so when it can't check (offline, say). Set
`LGTMOOSE_NO_RELEASE_CHECK=1` to skip it.

## Owner setup (once)

- **GHCR visibility.** The first release creates the three packages, private by default because
  the repository is private. Make them public (package settings → Change visibility), or give
  each deploying account read access. Note that a private package means `docker pull` during a
  deploy needs `docker login ghcr.io` with a token that can read packages.
- **Let Actions open the version pull request:** Settings → Actions → General → Workflow
  permissions → "Allow GitHub Actions to create and approve pull requests". Without it, the
  version job fails and you run `pnpm changeset version` yourself in a pull request.
- **Protect `v*` tags** (Settings → Rules → New tag ruleset) so only maintainers can push them:
  pushing one publishes images.

## Checklist for v0.1.0

Tag v0.1.0 once M1–M6's acceptance criteria pass. Open now:

- [ ] NIC-853: the AWS smoke test passes on a real account (needs the account set up, see
      [smoke-test.md](smoke-test.md)).
- [ ] NIC-848: the pilot rollout on real repositories.
- [x] NIC-840: the dashboard: sign-in, open findings, review runs, the learnings queue (approve and reject), provider usage and acceptance by rule category.
- [ ] NIC-843: the docker compose deployment is built ([compose.md](compose.md)); it still needs a real run on a host, like the AWS smoke test.
- [ ] NIC-838: the monthly learnings sync pull request (waiting on the decision between
      `contents: write` for every install and an opt-in permission).

Then:

1. Merge the "Version packages" pull request, so `apps/cli/package.json` says `0.1.0` and the
   changelog has its section.
2. On an up-to-date `main`:

   ```bash
   git tag -s v0.1.0 -m "LGTMoose 0.1.0"
   ```

   ```bash
   git push origin v0.1.0
   ```

3. Watch the release workflow. If a scan fails, fix it on `main`, then delete the tag (local
   and remote) and tag again: nothing was pushed.
4. Check the release notes, then verify one image with `gh attestation verify` as above.
5. Mark NIC-847 Done.
