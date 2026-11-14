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

Each blocked tier prints Bedrock's own problems, such as "model access not granted" or "not offered in this region". Under "To fix", each problem's one fix is listed once: request model access, pick another region, fix the id in `models.<tier>`, or grant `bedrock:ListInferenceProfiles`.

Access is checked for the whole account (region, model access, agreement), which also covers the sandbox task role. Your own IAM permission to call a model is shown only as a note. An account-wide error, such as access denied or throttling, fails the command.

## Secret contract

The credential broker (NIC-825) and the CDK stacks rely on this.

- **Name:** `lgtmoose/provider/<id>`, where `<id>` is the provider's `id` in `lgtmoose.config.ts`. It's built by `SECRET_NAMES.provider(id)`, with the prefix in `PROVIDER_SECRET_PREFIX` (`@lgtmoose/config`).
- **Value:** the credential as plain text, exactly what the sandbox reads from `LGTMOOSE_PROVIDER_CREDENTIAL`. The sandbox trims it before use.
  - `oauth-token`: the `sk-ant-oat…` token from `claude setup-token`
  - `api-key`: the vendor's API key
  - `access-token` and `service-account`: the token or key
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
