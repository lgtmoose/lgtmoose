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

Each command stores the credential for the provider in `lgtmoose.config.ts` that uses its harness and auth method. When more than one provider fits, pick one with `--id <id>`.

Before storing a plan credential, auth shows a warning about vendor terms and asks you to confirm. Plan credentials are `oauth-token`, `chatgpt-login`, a Codex `access-token` (it belongs to a ChatGPT plan) and a Cursor user `api-key` (it bills to that user's Cursor plan). A Cursor `service-account` key belongs to the team, so it gets no warning. `--accept-vendor-terms` answers yes. NIC-820 will update the warning with what each vendor's terms allow.

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
- **IAM.** Only the sandbox task role gets Bedrock permissions, and only when a Bedrock provider is configured:
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
- The system prompt, such as the review rules and rule packs, is passed as a cacheable prefix, so repeated runs read it from the prompt cache.
- The answer is checked against the schema, with one repair turn in the same session, and limits are reported to the fallback chain as `rate_limit`, `plan_limit` and `auth` failures, as the other harnesses do.

The SDK version (`@anthropic-ai/claude-agent-sdk` in `packages/harness`) tracks the Claude Code version the sandbox image installs, and the harness runs that installed `claude` binary.

## Secret contract

The credential broker (NIC-825) and the CDK stacks rely on this.

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
