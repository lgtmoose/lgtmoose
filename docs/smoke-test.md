# AWS smoke test

`.github/workflows/smoke-aws.yml` checks that a real deployment works end to end. It's started by hand from the Actions tab ("AWS smoke test", **Run workflow**) and does this:

1. Writes an `lgtmoose.config.ts` for the environment's region and org, with Claude Code on Bedrock, which needs no stored model credential.
2. Runs `pnpm lgtmoose deploy --yes`. This bootstraps the CDK if needed, deploys every stack, and points the test App's webhook at the new gateway.
3. Sends three signed deliveries to the gateway:
   - a `ping`, which must answer 200;
   - the same `ping` with a wrong signature, which must answer 401;
   - a comment on a made-up PR in the allowed org, which must answer 202. The gateway answers 202 only once the job is on the SQS queue.
4. Looks for that delivery in the dispatcher's log, to show the job went from the queue to the dispatcher. A comment job is acknowledged there without starting a review, so the run makes no model calls and starts no review tasks.
5. Runs `pnpm lgtmoose destroy --purge --yes`, always: also when an earlier step failed or the run was cancelled.
6. Checks that no `Lgtmoose-*` stack is left.

Nothing is read from or written to a real repository. A run takes about an hour. It costs a few dollars, mostly the RDS instance and NAT for that hour.

## What the account owner sets up

Do this once, before the first run.

### 1. An AWS account

Use a dedicated account. If you can't, use a region nothing else in the account uses. `destroy --purge` deletes LGTMoose's stacks, database, database secret and bucket in that region. The CDK bootstrap stack (`CDKToolkit`) is left in place, so later runs are faster.

### 2. GitHub's OIDC provider in that account

Do this once per account. Skip it if the account already has the provider.

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

### 3. An IAM role for the workflow

Name it, for example, `lgtmoose-smoke`. Its trust policy accepts only jobs in this repository's `aws-smoke` environment. Pull requests and other workflows can't assume it. Replace `ACCOUNT_ID`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:lgtmoose/lgtmoose:environment:aws-smoke"
        }
      }
    }
  ]
}
```

Set its **maximum session duration to 3 hours**:

```bash
aws iam update-role --role-name lgtmoose-smoke --max-session-duration 10800
```

The workflow asks for 3 hours, because a deploy and destroy together take more than the default 1.

**Permissions.** In a dedicated account, the simplest is `AdministratorAccess`. The CDK bootstrap creates IAM roles, and `lgtmoose deploy` and `destroy` also call Secrets Manager, RDS and CloudFormation directly.

To narrow it, run the bootstrap once yourself with an admin profile:

```bash
pnpm lgtmoose deploy
```

You can stop that deploy once bootstrapping is done. Then give the role only these:

- `sts:AssumeRole` on `arn:aws:iam::ACCOUNT_ID:role/cdk-*`, the bootstrap's deploy, publishing and lookup roles;
- `cloudformation:DescribeStacks`, `DescribeStackResources`, `ListStacks` and `DescribeStackEvents`;
- `secretsmanager:GetSecretValue`, `DescribeSecret` and `ListSecrets` on `lgtmoose/*`, plus `DeleteSecret` for `--purge`;
- `rds:DescribeDBInstances` and `ModifyDBInstance`, to switch deletion protection off and on;
- `logs:FilterLogEvents` on the `Lgtmoose-Workflow-*` log groups;
- `ssm:GetParameter` on `/cdk-bootstrap/*`.

### 4. A test GitHub App

Create it with `lgtmoose setup` against the test account and region, using an admin profile. Setup stores the App's keys and webhook secret in that account's Secrets Manager, where `deploy` reads them. The run sends GitHub nothing except pointing this App's webhook at the gateway, then back at a placeholder, so the App doesn't need to be installed anywhere. Don't reuse a production App: the run repoints its webhook.

### 5. The `aws-smoke` environment

In the repository's **Settings → Environments**, create `aws-smoke`:

- **Required reviewers:** at least one maintainer, so each run is approved before it can assume the role.
- **Deployment branches:** `main` only.
- **Environment variables** (variables, not secrets; none of these is secret):

  | Variable       | Value                                                                      |
  | -------------- | -------------------------------------------------------------------------- |
  | `AWS_ROLE_ARN` | `arn:aws:iam::ACCOUNT_ID:role/lgtmoose-smoke`                              |
  | `AWS_REGION`   | the region from step 1, the same one setup used                            |
  | `SMOKE_OWNER`  | the GitHub org or user `lgtmoose setup` was run for, used as `allowedOrgs` |

## When a run fails

The destroy step runs whatever happened before it. If it fails too, the last step lists the stacks left behind. Run `pnpm lgtmoose destroy --purge` locally with an admin profile: it deletes them in the right order.

## What it doesn't check

These need a person, or a real repository with the App installed:

- A full review on a real PR: clone, model call, posted review and check run.
- The review-thread sync through GitHub's GraphQL API (resolving a thread on a real LGTMoose comment).
- That the egress proxy lets the sandbox reach each provider's hosts and nothing else.
- The Cursor CLI tarball checksums, recorded when a Cursor provider is first built.
