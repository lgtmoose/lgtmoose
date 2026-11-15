# Learning

LGTMoose learns from your team: what it may accept, how your code is scoped and which conventions hold. Learnings are stored in the deployment's database, scoped to an org, a repository or paths in a repository, and the relevant ones are added to each review's prompt.

Memory writes are the main way an attacker could steer a reviewer, so who may write a learning is enforced in code, not in the prompt.

## Where learnings come from

- **`@lgtmoose learn: <text>`** in a PR comment. Tags narrow or widen it: `[path <glob>]`, `[org]`, `[kind <kind>]`, `[category <name>]`. See [Commands](commands.md).
- **A declined finding.** When a person declines a finding in a reply and the reply judge sees a general rule in their reason, it proposes a learning on their behalf.

Kinds are `accepted_pattern`, `correction`, `convention` and `scoping`. A `learn:` comment is a repo-wide `convention` unless its tags say otherwise.

## The write policy

`@lgtmoose/learnings` enforces it:

- The model, or a comment's text, only proposes a learning: its kind, text, category and scope. Who proposed it, on which PR and comment, and their permission at the time come from GitHub, never from the proposal.
- A repo or path learning is active at once when its author has write access or higher on the repo. An org-wide one needs an owner of the org (the org memberships API), since anyone who creates a repo is admin on it. Anything else waits as `pending`. Approving or forgetting needs the same access.
- A learning that could quiet findings (`accepted_pattern`, `scoping`, `correction`) can't name a protected category: `authz`, `tenant_scoping`, `money` or `secrets`.
- The text is scanned and redacted before it's stored, pending ones included: tokens, keys, credentials in URLs, JWTs, emails, phone and card numbers.
- `@lgtmoose forget <id>` retires a learning. Its row and its `learning_events` history stay.

Pending learnings are approved (or rejected) on the [dashboard](dashboard.md#approving-and-rejecting-learnings), with the same access rules.

Not built yet: an `approve` command on PRs, a limit on how many pending learnings one person can propose, and the monthly sync PR that writes learnings into the repository.

## Retrieval: learnings in reviews

The prepare step (the control task) picks each batch's learnings; the sandbox only sees their text in its prompt.

1. **Scope.** Active learnings of the PR's org: org-wide ones, and the PR's repo's whose path glob (if any) matches one of the batch's files.
2. **Rank.** With `learnings.embeddings` set to `bedrock` (Titan Text Embeddings v2 in the deployment's account) or `openai` (its embeddings API, with the key in `lgtmoose/embeddings/openai`), learnings and the batch's diff are embedded and ranked by pgvector cosine distance. A learning is embedded the first time it's ranked with a model, and the model is stored with the vector, so changing provider re-embeds rather than comparing unlike vectors. With `none` (the default), or when the provider fails, learnings are ranked by shared keywords, with no network call.
3. **Prompt.** The top 15 go in the batch's prompt after the PR and before the diff, each in an untrusted block. The prompt says a learning can't relax the rules or their severities, and never quiets a protected-category finding. Learnings are context only: no code drops or downgrades a finding because of one.
4. **Use.** Each learning put in a prompt has `hits` counted and `last_used_at` set. The reconciler retires active learnings unused for 90 days, with a `retired` event by `lgtmoose` (permission `system`), so their history stays.

The embeddings provider receives learning text and batch diffs. Only the control task can reach it: its role gets `bedrock:InvokeModel` on the one Titan model, or read access to the OpenAI key's secret. Sandbox roles get neither. `learningsForPullRequest` lists the learnings that apply to a PR, for the `learnings` command.
