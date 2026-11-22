# Provider credentials

`lgtmoose auth` stores each model provider's credential in AWS Secrets Manager, in the region from `lgtmoose.config.ts`. Values are read without echo, and are never printed, logged or saved to disk. The one exception is `auth codex`, which needs a temporary `CODEX_HOME` for `codex login`. That directory is private (mode 0700) and is deleted as soon as `codex login` finishes, before the upload, whether it worked, failed or was stopped with Ctrl+C.

| Command                             | Harness / auth                                  | What it does                                                  |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| `auth claude`                       | `claude-code` / `oauth-token`                   | Runs `claude setup-token`, then asks you to paste the token   |
| `auth codex`                        | `codex` / `chatgpt-login`                       | Runs `codex login` and uploads its `auth.json`                |
| `auth codex --access-token`         | `codex` / `access-token`                        | Asks for a Codex access token                                 |
| `auth cursor`                       | `cursor-agent` / `api-key` or `service-account` | Asks for a Cursor API key                                     |
| `auth api-key --provider anthropic` | `claude-code` or `agent-sdk` / `api-key`        | Asks for an Anthropic API key                                 |
| `auth api-key --provider openai`    | `codex` / `api-key`                             | Asks for an OpenAI API key                                    |
| `auth vertex <key-file>`            | `claude-code` or `agent-sdk` / `vertex`         | Uploads a Google Cloud service-account key (JSON)             |
| `auth bedrock`                      | any / `bedrock`                                 | Checks Anthropic model access in the region. Stores nothing   |
| `auth list`                         |                                                 | Shows which providers have a credential, and stray secrets    |
| `auth remove <id>`                  |                                                 | Schedules the credential for deletion, recoverable for 7 days |

`auth linear` stores a Linear API key for [ticket coverage](tickets.md), not a model credential. It goes in `lgtmoose/tickets/linear`, and only the control task can read it.

Each command stores the credential for the provider in `lgtmoose.config.ts` that uses its harness and auth method. When more than one provider fits, pick one with `--id <id>`.

Before storing a plan credential, auth shows a warning about vendor terms and asks you to confirm. Plan credentials are `oauth-token`, `chatgpt-login`, a Codex `access-token` (it belongs to a ChatGPT plan) and a Cursor user `api-key` (it bills to that user's Cursor plan). A Cursor `service-account` key belongs to the team, so it gets no warning. `--accept-vendor-terms` answers yes. [Providers](providers.md) has what each vendor's terms say, with sources, and the recommended credential per vendor.

`auth bedrock` checks the model each Bedrock provider uses for each tier: its `models`, or the harness default. The command fails if a tier can't run.

- A bare model id must be callable on demand.
- A cross-region profile id (`us.`, `eu.`, `global.` and so on) must be one of the inference profiles Bedrock lists for the region.
- A context-window suffix such as `:200k` is checked as its base model.
- A pinned legacy model is checked too, and flagged.
- A Claude Code family alias (`haiku`, `sonnet`, `opus`, `opusplan`, with or without a modifier such as `[1m]`) isn't checked. Claude Code picks the model at runtime, so the output lists the family's usable models as a hint; pin a model id in `models` to have it checked. The command fails only when a family has no usable model at all. `opusplan` needs both Opus and Sonnet.
- Anything that isn't a Bedrock model id fails, such as an Anthropic API id like `claude-sonnet-4-5-20250929`.
- `default` and ARNs are reported as not checked.

The list of models shows the ids to pin for each one: the bare id when it can be called on demand, otherwise the inference profiles Bedrock lists for it in the region. A model with neither can't be called here, so it's listed as blocked. Without `bedrock:ListInferenceProfiles`, profile ids are reported as not checked, while on-demand ids are still checked.

Each blocked tier prints Bedrock's own problems, such as "model access not granted" or "not offered in this region". When a model isn't offered in the region, or has no way to be called there, that is the only problem shown, since access wouldn't help. After the notes, "To fix" lists each problem's one fix once: request model access, wait for a pending agreement, pick another region, fix the id in `<provider>.models.<tier>`, or grant `bedrock:ListInferenceProfiles`.

Access is checked for the whole account (region, model access, agreement), which also covers the sandbox task role. Your own IAM permission to call a model is shown only as a note. An account-wide error, such as access denied or throttling, fails the command.

## Bedrock with AWS credits

This is the default setup path: the models run on Amazon Bedrock in the account LGTMoose is deployed to, so AWS credits pay for them and no secret is stored.

1. In the Bedrock console for the region in `lgtmoose.config.ts`, request access to the Anthropic models.
2. Add a provider with `auth: "bedrock"` and the `claude-code` or `agent-sdk` harness. Pin `models.fast`, `models.standard` and `models.deep` to the ids `auth bedrock` lists: a bare model id that can be called on demand, or a cross-region inference profile (`us.`, `eu.`, `apac.`, `global.`).
3. Run `pnpm lgtmoose auth bedrock`, then `pnpm lgtmoose deploy`.

What the deploy sets up for a Bedrock provider:

- **Environment.** Sandbox tasks get `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION`. Credentials come from the ECS task role, through the AWS SDK's default chain. Each pinned tier is passed as `ANTHROPIC_DEFAULT_HAIKU_MODEL` (fast), `ANTHROPIC_DEFAULT_SONNET_MODEL` (standard) and `ANTHROPIC_DEFAULT_OPUS_MODEL` (deep), so the aliases Claude Code uses on its own, such as the Haiku model for background tasks, resolve to the same pinned models. See [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock).
- **IAM.** Only the sandbox task role can call a model, and only when a Bedrock provider is configured. The health check's role may only describe the pinned models ([Model checks](#model-checks)):
  - `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`. With all three tiers pinned to Anthropic ids, these are allowed on exactly those foundation models (in any region, since a cross-region profile routes to several) and their inference profiles in the account. When a tier still uses an alias, Claude Code picks the model at runtime, so they're allowed on every `anthropic.*` foundation model and Anthropic inference profile, and never on other vendors' models.
  - `bedrock:ListInferenceProfiles` and `bedrock:GetInferenceProfile`, which Claude Code uses to find the profile for a model.
- **Egress.** The proxy lets sandbox tasks reach `bedrock-runtime.<region>.amazonaws.com` (model calls) and `bedrock.<region>.amazonaws.com` (profile lookups).

## Vertex AI

For Claude on Google Cloud Vertex AI, add a provider with `auth: "vertex"` and the `claude-code` or `agent-sdk` harness:

```ts
{
  id: "vertex",
  harness: "claude-code",
  auth: "vertex",
  vertex: { region: "global", projectId: "acme-reviews" },
  models: { fast: "claude-haiku-4-5@20251001", standard: "claude-sonnet-4-6", deep: "claude-opus-4-8" },
}
```

- `vertex.region` is `CLOUD_ML_REGION`: `global` (the default), a multi-region (`us`, `eu`) or a region such as `us-east5`. `vertex.projectId` is `ANTHROPIC_VERTEX_PROJECT_ID`; left out, the key's `project_id` is used.
- Create a service account with the Vertex AI User role (`roles/aiplatform.user`) in the project, enable the Claude models in Model Garden, and download a JSON key for the account. Then run `pnpm lgtmoose auth vertex path/to/key.json`. It checks the file is a service-account key and stores it; the file isn't changed or deleted.
- At run time the sandbox writes the key to `google-credentials.json` in the run's temporary home, with mode 0600, and points `GOOGLE_APPLICATION_CREDENTIALS` at it. The home, key included, is deleted when the run ends. The key's JSON and its private key are redacted from transcripts and errors, and a review that contains either is refused.
- Pinned tiers are passed as `ANTHROPIC_DEFAULT_*_MODEL`, as for Bedrock. See [Claude Code on Google Vertex AI](https://code.claude.com/docs/en/google-vertex-ai).
- Egress allows the Vertex endpoint for the region (`aiplatform.googleapis.com` for `global`, `aiplatform.us.rep.googleapis.com` or `aiplatform.eu.rep.googleapis.com` for a multi-region, `<region>-aiplatform.googleapis.com` otherwise) and `oauth2.googleapis.com`, where the key is exchanged for an access token.

## The agent-sdk harness

`harness: "agent-sdk"` runs the review through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) in the sandbox process, instead of running `claude -p`. It takes `api-key`, `bedrock` and `vertex` auth. Claude subscription tokens (`oauth-token`) aren't allowed for products built on the Agent SDK, so it refuses them.

It keeps the `claude-code` harness's policy: the same read-only tools (Read, Grep, Glob, and Bash limited to plain git reads), no settings files, CLAUDE.md files, MCP servers or slash commands from the checkout, and the same hardening variables. On top of that:

- Bash commands are also checked in the SDK process by a `PreToolUse` hook, so the git read guard doesn't depend on a hook script alone.
- The review rules and rule packs (`system`) are appended to Claude Code's own system prompt, the one `claude -p` uses. Per-run sections such as the working directory and git status move to the first user message, so the system prompt is the same on every run and is read from the prompt cache.
- The answer is checked against the schema, with one repair turn in the same session, and limits are reported to the fallback chain as `rate_limit`, `plan_limit` and `auth` failures, as the other harnesses do.

The SDK version (`@anthropic-ai/claude-agent-sdk` in `packages/harness`) tracks the Claude Code version the sandbox image installs, and the harness runs that installed `claude` binary.

## The credential broker

The broker controls how review runs use the stored credentials. It runs as two Lambdas, and it never puts a credential in a log.

- **One credential per task.** Each provider has its own sandbox task definition, and that task definition carries only that provider's secret, `LGTMOOSE_PROVIDER_CREDENTIAL`.
  - The ECS execution role reads the secret to start the task.
  - The task's own role can't read any secret.
  - The task has no GitHub token.
  - Only the credential's variables reach the CLI, never the rest of the task's environment.
- **Leases.** Before each sandbox task starts, its batch takes a lease on the reviewer's credential, and it gives the lease back after the task, whether the task worked or not.
  - A credential has a fixed number of slots. Leases count across every review that runs at once.
  - When every slot is in use, the batch waits and asks again: every 20 seconds at first, then up to every 2 minutes, for about three hours. A batch that never gets a slot fails, and its review is incomplete.
  - A lease ends early when its review was stopped (a newer push, say). If a lease is never given back, it expires after 40 minutes.
- **Concurrency.** A provider's `concurrency` in `lgtmoose.config.ts` sets how many slots it has. The defaults:

  | Credential                                                                              | Slots     |
  | --------------------------------------------------------------------------------------- | --------- |
  | ChatGPT sign-in (`chatgpt-login`)                                                       | 1, always |
  | Other plan credentials (`oauth-token`, a Codex `access-token`, a Cursor user `api-key`) | 2         |
  | API keys and service accounts                                                           | 16        |

  Lower it for a plan that objects to parallel use:

  ```ts
  { id: "claude", harness: "claude-code", auth: "oauth-token", concurrency: 1 }
  ```

- **Refreshed tokens.** Codex refreshes a ChatGPT sign-in's tokens during a run, and the refresh retires the old refresh token. That is why a sign-in has one slot. The sandbox hands the new `auth.json` to a presigned URL for its batch. When the batch gives its lease back, the broker stores the new `auth.json` as a new version of the secret, but only if all of these hold:
  - the batch still holds its lease;
  - the secret hasn't changed since the task started, so a newer `lgtmoose auth codex` isn't overwritten;
  - the new file is an `auth.json`, and it and the stored one have the same non-empty `tokens.account_id`.

  A sign-in stored without an account ID gets no refresh write-back. Codex's own `auth.json` type makes `account_id` optional, so this can happen. Its refreshed tokens are refused, the credential alarm fires, and runs keep using the stored tokens until their refresh token stops working. Run `lgtmoose auth codex` again to store a sign-in that has one.

  The handed-back object is deleted either way. The broker can read and write the value of a ChatGPT sign-in's secret only. For every other credential it can only describe the secret.

- **Audit log.** The broker's log group records every lease taken, taken over and given back, and every refresh stored or refused. Each entry has the run, the batch, the slot and the secret's version ID, never a value. The log is kept for 3 months on the `lean` profile and a year on `standard`, and it is kept when the stack is deleted.
- **Health and alarms.** Each stored credential has an alarm, `CredentialAlarm-<id>`, on the `LGTMoose` `CredentialProblem` metric for that provider. Two things set the metric to 1:
  - A check every 6 hours. It describes each provider's secret without reading it, and flags a secret that is missing, scheduled for deletion or has no current version. It also flags a Claude `oauth-token` stored 330 days ago or more, since `claude setup-token` tokens last a year.
  - A review run that the vendor refused for auth, which is how an expired or revoked token shows up.

  The alarm clears once a check finds nothing wrong. The fix is usually `lgtmoose auth` for that provider.

A Bedrock provider has no stored credential. It has no lease, no slots and no credential alarm. Its models have their own alarm (see below).

## Model checks

A model the account can't call fails every review that reaches it. So LGTMoose checks each pinned model before the first review, and again on a schedule.

What's checked, per provider:

| Provider                                         | How                                                                                                                                                                                                                                                                                                 | When                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Bedrock (`claude-code` or `agent-sdk`)           | An inference profile (`us.…`, `global.…`) must exist in the region and be active. A bare model ID must exist and take on-demand calls. Either way the account must have model access and the model's agreement accepted. These are Bedrock control-plane reads, free and without calling the model. | `lgtmoose deploy`, and every 6 hours in the health check  |
| Anthropic API key (`claude-code` or `agent-sdk`) | `GET https://api.anthropic.com/v1/models/<model>` with the stored key. Free.                                                                                                                                                                                                                        | `lgtmoose deploy`, and every 6 hours under docker compose |
| OpenAI API key (`codex`)                         | `GET https://api.openai.com/v1/models/<model>` with the stored key. Free.                                                                                                                                                                                                                           | `lgtmoose deploy`, and every 6 hours under docker compose |

A few answers are reported as "couldn't check" rather than "can't be called", so they never raise or clear an alarm:

- an API key that gets HTTP 403 on the models endpoint, or a 401 whose error doesn't call the key invalid (a restricted OpenAI key without `api.model.read` gets one, and still works for reviews). A 401 saying the key is invalid is "can't be called";
- an active inference profile whose model the source region doesn't offer or doesn't know, since Bedrock then reports model access as not granted whatever the account has;
- any throttled or denied control-plane call.

A bare model ID, `:200k`-style variants included, is checked as configured, since that's what Claude Code calls. One that takes only provisioned throughput can't be used: pin a model that takes on-demand calls.

Not checked: model aliases such as `sonnet`, which Claude Code resolves to a model ID only when it runs (pin model IDs to have them checked); ARNs, which are used as given; Vertex AI; Cursor; and subscription sign-ins, which have no cheap way to ask. A model several tiers share is checked once.

- **At deploy.** A model that can't be called is a warning, before anything is deployed, naming the provider, the tiers, the model ID, the region and the fix: usually the Bedrock console's model access page, or the right profile ID. The deploy goes ahead, since a fallback provider may still cover it and model access can be granted after. The identity running `lgtmoose deploy` needs `bedrock:GetInferenceProfile`, `bedrock:GetFoundationModel` and `bedrock:GetFoundationModelAvailability`; without them, the models are reported as not checked.
- **In the health check.** The 6-hourly check sets the `LGTMoose` `ModelUnavailable` metric for each provider with a checked model: 1 when one of its models can't be called; 0 when none can't be called and at least one passed; nothing when every check of it couldn't run. Each provider has an alarm on it, `ModelAlarm-<id>`. The log line `model unavailable` names the tiers, model, region and fix. A check that couldn't run (throttled, say) changes nothing. On AWS only Bedrock models are checked here: the Lambda's role may describe exactly the pinned profiles and models in the stack's region, plus `bedrock:GetFoundationModelAvailability` (granted on `*`: AWS's reference couldn't be confirmed to support resource-level permissions for it), and can't call any model or read any secret. An API key that stops working shows up as a run refused for auth instead (`CredentialProblem`). Under docker compose the runner already holds the keys, so it checks API-key models too. Compose can't run Bedrock providers at all (it refuses them at start), so there is no Bedrock model to check there. If a run ever has Bedrock checks but no Bedrock client, it logs `Bedrock models not checked` once rather than passing them silently.

If the Lambda runtime's own `@aws-sdk/client-bedrock` is missing a command the check needs, the model check logs `model checks not run` and is skipped. The credential check still runs and reports as usual.

A check doesn't reorder the fallback chain. A batch still tries the provider, and moves to the next one if the failure is one the chain falls back on.

## Secret contract

The credential broker and the CDK stacks rely on this.

- **Name:** `lgtmoose/provider/<id>`, where `<id>` is the provider's `id` in `lgtmoose.config.ts`. It's built by `SECRET_NAMES.provider(id)`, with the prefix in `PROVIDER_SECRET_PREFIX` (`@lgtmoose/config`).
- **Value:** the credential as plain text, exactly what the sandbox reads from `LGTMOOSE_PROVIDER_CREDENTIAL`. The sandbox trims it before use.
  - `oauth-token`: the `sk-ant-oat…` token from `claude setup-token`
  - `api-key`: the vendor's API key
  - `access-token` and `service-account`: the token or key
  - `vertex`: the Google Cloud service-account key file's JSON, on one line
  - `chatgpt-login`: the whole `auth.json` that `codex login` wrote, as JSON:

    ```json
    {
      "OPENAI_API_KEY": null,
      "tokens": { "id_token": "…", "access_token": "…", "refresh_token": "…", "account_id": "…" },
      "last_refresh": "2026-11-14T00:00:00Z"
    }
    ```

    Auth checks that `tokens.refresh_token` is present. When Codex refreshes the tokens during a run, the broker writes the new `auth.json` back to the same secret as a new version.

- **Tags** (keys in `PROVIDER_CREDENTIAL_TAGS`). They describe the secret without its value:

  | Key                 | Value                                     |
  | ------------------- | ----------------------------------------- |
  | `app`               | `lgtmoose`                                |
  | `lgtmoose:kind`     | `provider-credential`                     |
  | `lgtmoose:provider` | the provider `id`                         |
  | `lgtmoose:harness`  | `claude-code`, `codex`, `cursor-agent`, … |
  | `lgtmoose:auth`     | the provider's `auth`, such as `api-key`  |

  Storing again replaces the value with a new version and resets the tags and description, in case the provider's harness or auth changed.

- **Description:** says which provider and auth method the secret is for. It holds no value.

To find every provider credential, list secrets with the name filter `lgtmoose/provider/`, then keep only names that start with it. Secrets Manager's name filter also matches the prefix of later words in a name.

Bedrock providers have no secret: sandbox tasks call Bedrock with their IAM role.

Running `auth` again for a provider whose secret was removed in the last 7 days restores the secret, then stores the new value.
