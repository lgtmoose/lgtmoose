# LGTMoose

A self-hosted, open-source AI pull request reviewer. You deploy it to your own AWS account as a GitHub App, and it reviews every pull request: inline comments, a summary, a status label and a check run. Your team steers it with `@lgtmoose` commands and replies, and teaches it with learnings.

> **Status: alpha.** LGTMoose hasn't been run in production yet, its end-to-end smoke test on a real AWS account hasn't passed, and the first tagged release (v0.1.0) is still to come. Reviews run in shadow mode by default: they're recorded, not posted. Report a vulnerability as described in [Security](security.md).

## Pages

- [Architecture](architecture.md): the components, how a review runs, harnesses and fallback, security controls
- [Configuration reference](configuration.md): every key in `lgtmoose.config.ts` and `.lgtmoose.yaml`
- [Providers and auth](credentials.md): storing model credentials, Bedrock, Vertex AI, the credential broker
- [Vendor terms](providers.md): what each vendor's terms say about plan credentials and bot approvals
- [Rule packs](rule-packs.md): the review criteria, and adding your own
- [Commands](commands.md): `@lgtmoose` commands and replies on findings
- [Learning](learning.md): how learnings are written, approved and used
- [Feedback signals](feedback.md): acceptance per rule category, and declined findings as eval fixtures
- [Ticket coverage](tickets.md): checking each PR against the Linear tickets it names
- [Dashboard](dashboard.md): signing in with GitHub to see open findings and review runs
- [Evals](evals.md): measuring reviews on fixtures, and comparing providers
- [Costs](costs.md): what you pay AWS and your model vendors for
- [Security](security.md): the threat model and how to report a vulnerability
- [Troubleshooting](troubleshooting.md)
- [Upgrading](upgrading.md), and removing it
- [Releasing](releasing.md): changesets, how a release is published, and deploying a release's images
- [AWS smoke test](smoke-test.md): the end-to-end check on a throwaway account
- [docker compose](compose.md): running it on one host without AWS, and what holding the Docker socket means

## Quickstart

You need Node 24, pnpm 10, Docker, the AWS CLI signed in to the account to deploy to, and a GitHub organization or account to install the App in.

```bash
git clone https://github.com/lgtmoose/lgtmoose && cd lgtmoose && pnpm install
```

```bash
pnpm lgtmoose setup
```

```bash
pnpm lgtmoose auth bedrock
```

```bash
pnpm lgtmoose deploy
```

1. **`setup`** creates the GitHub App through GitHub's manifest flow, stores its keys in AWS Secrets Manager and writes `lgtmoose.config.ts`. It starts you on Amazon Bedrock, which needs no stored key.
2. **`auth`** stores or checks a model provider's credential: `bedrock`, `claude`, `codex`, `cursor`, `api-key` or `vertex`. See [Providers and auth](credentials.md).
3. **`deploy`** bootstraps the AWS CDK the first time, deploys every stack, points the App's webhook at the gateway and prints the App's install link.

Install the App on the repositories you want reviewed. Reviews start in shadow mode; when you've checked a few in the artifact bucket's `shadow/` folder, set `shadow: false` in `lgtmoose.config.ts` and deploy again.

Each command takes `--help`. To try a review on one PR without deploying, run `pnpm lgtmoose review owner/repo#123 --dry-run` with a Claude Code credential in the environment.

## Docker

`deploy` builds the control and sandbox container images for ARM64, so it needs Docker running: Docker Desktop, or on x86 Linux, Docker with QEMU emulation for arm64 (for example `docker run --privileged --rm tonistiigi/binfmt --install arm64`).

## AWS permissions

`deploy` uses your current AWS credentials (for example `aws sso login` or `AWS_PROFILE`) and the region in `lgtmoose.config.ts`. Administrator access is simplest. A scoped role needs to assume the CDK bootstrap roles and create the bootstrap stack, plus the calls the CLI makes itself:

- `sts:GetCallerIdentity`
- `cloudformation:DescribeStacks` and `DescribeStackResources` (destroy finds the database through the Data stack's resources when a failed create left it without outputs)
- `secretsmanager:GetSecretValue`, `CreateSecret` and `PutSecretValue` on `lgtmoose/*` (setup writes them)
- `rds:DescribeDBInstances`, `DescribeDBClusters`, `ModifyDBInstance`, `ModifyDBCluster`, `StartDBInstance` and `StartDBCluster` (deploy checks the database's deletion protection, and destroy turns it off)
- For `auth`: `secretsmanager:CreateSecret`, `UpdateSecret`, `TagResource` (also needed to create a tagged secret), `RestoreSecret`, `DeleteSecret` and `DescribeSecret` on `lgtmoose/provider/*`, and `secretsmanager:ListSecrets`, which can't be limited to a resource
- For `auth bedrock`: `bedrock:ListFoundationModels`, `bedrock:GetFoundationModelAvailability` and `bedrock:ListInferenceProfiles`. Model aliases such as `sonnet` are only hinted at: Claude Code picks the model at runtime, so pin model ids in `models` to have them checked
- For deploy's [model checks](credentials.md#model-checks) on a Bedrock provider: `bedrock:GetInferenceProfile`, `bedrock:GetFoundationModel` and `bedrock:GetFoundationModelAvailability`. Without them, deploy warns that the models couldn't be checked and goes ahead

`auth` stores each provider's credential as `lgtmoose/provider/<id>`.

## Bedrock with AWS credits (the default)

If your AWS account has credits, run the models on Amazon Bedrock in the same account. There's no API key to store or rotate: sandbox tasks call Bedrock with their IAM task role, and the bill goes to the account.

1. In the Bedrock console for your region, request access to the Anthropic models you want.
2. Use a Bedrock provider in `lgtmoose.config.ts`, and pin each tier to a model id or inference profile:

   ```ts
   providers: [
     {
       id: "bedrock",
       harness: "claude-code", // or "agent-sdk"
       auth: "bedrock",
       models: {
         fast: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
         standard: "us.anthropic.claude-sonnet-4-6",
         deep: "us.anthropic.claude-opus-4-8",
       },
     },
   ],
   ```

3. Run `pnpm lgtmoose auth bedrock`. It checks each tier can be called in the region and lists the ids you can pin.
4. Run `pnpm lgtmoose deploy`.

Pinning matters for two reasons. Without pins, Claude Code picks the newest model of each family at runtime, so the task role may call any Anthropic model and profile. With all three tiers pinned, the task role may call only those models and their inference profiles. See [Providers and auth](credentials.md#bedrock-with-aws-credits) for the details, Vertex AI and the `agent-sdk` harness.

## One install per account

One AWS account and region holds one install for now, because the secret and stack names are fixed. Put a second install, such as staging, in another account or region.
