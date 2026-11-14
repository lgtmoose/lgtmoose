# Providers: vendor terms for plan credentials and bot approvals

This page records what each vendor's own documentation and terms say about running LGTMoose on a plan (subscription) credential. It also covers whether a GitHub App's approval counts towards required reviews. It answers the questions in NIC-820 and backs the warning `lgtmoose auth` shows before storing a plan credential.

This is not legal advice. Terms change often. Where the sources are silent or ambiguous, this page says so rather than guessing. Check the linked pages before you rely on any of this.

Sources were read on 2026-11-14:

- **Read in full:** the Anthropic pages.
- **Read through search excerpts of the vendors' own pages:** the OpenAI, Cursor and GitHub pages. Their sites refused direct requests from the research environment. Quotes from them are marked "(excerpt)".

## Summary

| Vendor         | Credential                                                                           | What the vendor says                                                                                                                                | Status for a team-wide review bot                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic      | Claude Pro or Max `setup-token` OAuth token                                          | Documented for "CI pipelines and scripts". The consumer terms forbid making your account available to anyone else.                                  | **Unclear.** Running it yourself is documented. Reviewing a whole team's PRs on one person's plan is not addressed, and arguably conflicts with the account-sharing clause. |
| Anthropic      | Claude Team or Enterprise `setup-token`                                              | Same token. Commercial terms govern Team and Enterprise.                                                                                            | **Unclear.** The token still belongs to one seat.                                                                                                                           |
| Anthropic      | API key (including one from a Max, Ultra or Team plan's linked Console organization) | API keys are the documented exception for automated access. Max, Ultra and Team include monthly API credits that cover `claude -p` with such a key. | **Allowed.** Recommended.                                                                                                                                                   |
| OpenAI         | ChatGPT sign-in `auth.json`                                                          | Documented as an advanced CI/CD option. The consumer terms forbid sharing account credentials or making your account available to others.           | **Unclear** for team-wide use.                                                                                                                                              |
| OpenAI         | Codex access token                                                                   | Business and Enterprise workspaces only, enabled by a workspace owner. It represents the user who created it, and is meant for trusted runners.     | **Allowed within a Business or Enterprise workspace**, as that user's identity.                                                                                             |
| OpenAI         | API key                                                                              | OpenAI's recommended default for CI.                                                                                                                | **Allowed.** Recommended.                                                                                                                                                   |
| Cursor         | User API key                                                                         | Works with the CLI, and bills to that user's plan. Cursor staff say account sharing is against the terms.                                           | **Discouraged.**                                                                                                                                                            |
| Cursor         | Service account key                                                                  | An Enterprise feature, made for automation "without tying integrations to individual developers' personal accounts" (excerpt).                      | **Allowed.** Recommended on Enterprise.                                                                                                                                     |
| Amazon Bedrock | IAM role                                                                             | No stored credential, so no plan terms apply. AWS's own service terms apply.                                                                        | **Allowed.** Recommended.                                                                                                                                                   |
| GitHub         | App approval vs required reviews                                                     | Required reviews count approvals from accounts with write access. GitHub doesn't document GitHub App approvals counting.                            | **Don't rely on it.** Make the LGTMoose check run a required status check instead.                                                                                          |

## Anthropic

**Claude Code's `setup-token`.** The Claude Code authentication docs present it as the path for unattended use ([Authentication](https://code.claude.com/docs/en/authentication)):

> For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`

> This token authenticates with your Claude subscription and requires a Pro, Max, Ultra, Team, or Enterprise plan. It can only make model requests

**Billing.** Usage on a plan token draws from the plan's limits. The Agent SDK help article was last updated with this on 2026-10-07 ([Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)):

> Claude Max, Ultra, and Team plans now include monthly API credits. They cover the Claude API, Claude Managed Agents, and the Claude Agent SDK and `claude -p` when you run them with an API key from your linked Claude Console organization. Nothing changes for your plan: when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits.

The earlier announced change to Agent SDK billing was paused on 2026-06-15 ("for now, nothing has changed").

**Consumer terms (Pro and Max).** Effective 2025-10-08 ([Consumer Terms](https://www.anthropic.com/legal/consumer-terms)):

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.

> [You may not use the Services] Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

- **Automation on your own plan:** the Claude Code docs explicitly offer `setup-token` for scripts and CI. That reads as the explicit permission the automation clause allows for, so running it yourself is documented.
- **Team-wide bot on one person's plan:** nothing says a token may serve a bot that reviews other people's pull requests. The account-sharing clause points against it.

**Commercial terms (Team, Enterprise and API).** These govern business use ([Commercial Terms](https://www.anthropic.com/legal/commercial-terms)). They allow using the Services "to power products and services Customer makes available to its own customers and end users". A Team seat's `setup-token` still belongs to one seat, and the terms don't address that case.

**Recommendation.** Use an API key: `lgtmoose auth api-key --provider anthropic`. On a Max, Ultra or Team plan, create it in the plan's linked Claude Console organization, so the plan's monthly API credits cover it. Bedrock is the other option. Store a `setup-token` only for your own repositories, or after confirming with Anthropic that your plan allows this use.

## OpenAI (Codex)

**API keys.** OpenAI's Codex docs make API keys the default for automation. The [Authentication](https://developers.openai.com/codex/auth) page says API keys are the right default for automation because they are simpler to provision and rotate (excerpt).

**Codex access tokens.** From [Access tokens](https://developers.openai.com/codex/enterprise/access-tokens) (excerpts):

- Supported for ChatGPT Business and Enterprise workspaces only.
- A workspace owner enables them.
- A token "represents the ChatGPT workspace user who created it".
- They are meant for trusted runners: tokens on public CI, forked pull requests or shared machines can be exposed. OpenAI suggests separate tokens per workflow owner.

**Copying `auth.json`.** A ChatGPT sign-in's `auth.json` is a documented advanced option: [Maintain Codex account auth in CI/CD (advanced)](https://developers.openai.com/codex/auth/ci-cd-auth). Codex refreshes it in place, and it should be treated like a password (excerpt).

**Terms.** OpenAI's [Terms of Use](https://openai.com/policies/row-terms-of-use/) forbid sharing account credentials or making your account available to others (excerpt). The [Services Agreement](https://openai.com/policies/services-agreement/) forbids sharing login credentials between users (excerpt). Neither addresses a bot that reviews other people's pull requests with one person's ChatGPT sign-in.

**Recommendation.** Use an OpenAI API key: `lgtmoose auth api-key --provider openai`. On Business or Enterprise, a Codex access token created for the bot is the documented alternative. Store a personal ChatGPT sign-in only for your own repositories.

## Cursor

**CLI keys.** The CLI takes a user API key or a service-account key as `CURSOR_API_KEY`. [Service accounts](https://cursor.com/docs/account/enterprise/service-accounts) are an Enterprise feature. Cursor describes them as letting teams run automation "without tying integrations to individual developers' personal accounts" (excerpt). A user API key bills to that user's plan.

**Terms.** Cursor's [Master Services Agreement](https://cursor.com/terms/msa) makes the customer responsible for ensuring an authorized user's login isn't shared by several people (excerpt). Cursor staff on the forum say account sharing is against the [Terms of Service](https://cursor.com/terms-of-service); that is a secondary source. The excerpts of the consumer terms found no explicit clause on bots.

**Recommendation.** Use a service-account key: `lgtmoose auth cursor` with a provider of `auth: "service-account"`. Store a user API key only for your own repositories.

## GitHub: do App approvals count towards required reviews?

**What GitHub documents.** Required reviews count approvals from people with write permission in the repository ([About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)). Two related points:

- Submitting a review needs the App's "Pull requests: write" permission ([Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)).
- GitHub's docs say Copilot's reviews don't count towards required approvals ([Approving a pull request with required reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews), excerpt).

**What GitHub doesn't document.** Nothing says whether a GitHub App's approval counts. Community tests report that it counts only when the App also has "Contents: write". LGTMoose's App asks for "Contents: read", so its approvals should be expected not to count.

**What changes changes-requested.** A changes-requested review from the App blocks merging under branch protection, until the same reviewer approves.

**Recommendation.** Make the `lgtmoose` check run a required status check on protected branches, and keep a human approval requirement. LGTMoose's approval is then a signal, not the gate. Don't grant "Contents: write" just to make approvals count: the App only needs to read code.

## What LGTMoose does with this

- Before storing a plan credential, `lgtmoose auth` shows a short warning that matches the vendor and names its documented alternative, then asks for confirmation; `--accept-vendor-terms` answers yes. Plan credentials are a Claude `oauth-token`, a ChatGPT `chatgpt-login`, a Codex `access-token` and a Cursor user `api-key`. The warning links this page.
- `lgtmoose setup` starts with a Bedrock provider, which needs no stored credential. A plan credential is opt-in.
