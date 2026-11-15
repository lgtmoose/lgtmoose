# Learning

LGTMoose learns from your team: what it may accept, how your code is scoped and which conventions hold. Learnings are stored in the deployment's database, scoped to an org, a repository or paths in a repository, and the relevant ones are added to each review's prompt.

Memory writes are the main way an attacker could steer a reviewer, so who may write a learning is enforced in code, not in the prompt.

## Where learnings come from

- **`@lgtmoose learn: <text>`** in a PR comment. Tags narrow or widen it: `[path <glob>]`, `[org]`, `[kind <kind>]`, `[category <name>]`. See [Commands](commands.md).
- **The repository's review history.** A bootstrap reads past code review comments and proposes the team's rules. They are always pending until a person approves them. See [Starting with your history](#starting-with-your-history).
- **A declined finding.** When a person declines a finding in a reply and the reply judge sees a general rule in their reason, it proposes a learning on their behalf. When it sees no rule, it offers one line instead: reply `@lgtmoose remember` in the thread to stop raising findings like it in this repository.
- **Repeated rejections.** See [Learning from outcomes](#learning-from-outcomes).

Kinds are `accepted_pattern`, `correction`, `convention` and `scoping`. A `learn:` comment is a repo-wide `convention` unless its tags say otherwise.

## The write policy

`@lgtmoose/learnings` enforces it:

- The model, or a comment's text, only proposes a learning: its kind, text, category and scope. Who proposed it, on which PR and comment, and their permission at the time come from GitHub, never from the proposal.
- A repo or path learning is active at once when its author has write access or higher on the repo. An org-wide one needs an owner of the org (the org memberships API), since anyone who creates a repo is admin on it. Anything else waits as `pending`. Approving or forgetting needs the same access.
- A learning that could quiet findings (`accepted_pattern`, `scoping`, `correction`) can't name a protected category: `authz`, `tenant_scoping`, `money` or `secrets`.
- The text is scanned and redacted before it's stored, pending ones included: tokens, keys, credentials in URLs, JWTs, emails, phone and card numbers.
- `@lgtmoose forget <id>` retires a learning. Its row and its `learning_events` history stay.

- One author without write access can have at most `learnings.maxPendingPerAuthor` (5 by default) pending learnings in an org. A new one past that is refused and nothing is stored, so on a public repository one person can't fill the queue. This applies to `learn:` and to learnings proposed from replies; authors whose learnings apply at once aren't limited.

Pending learnings are approved with `@lgtmoose approve <id>` on a PR, or approved (or rejected) on the [dashboard](dashboard.md#approving-and-rejecting-learnings), with the same access rules.

Not built yet: the monthly sync PR that writes learnings into the repository.

## Starting with your history

A new install knows only your conventions files, so its first reviews are its noisiest. Most teams have already written their taste down in past code review comments. A bootstrap turns those comments into learnings, for you to approve before any review uses them.

### Starting one

- **On the dashboard:** open **Learn from history** and choose **Learn from history** next to a repository. You need write access to it. **Read older PRs** carries on below the oldest PR the last bootstrap read.
- **From the CLI, on AWS:**

  ```bash
  lgtmoose learnings bootstrap --repo acme/shop
  ```

  Options are `--prs <n>` (merged PRs to read, 200 by default, 1,000 at most), `--max-cost <usd>` and `--resume`. The command leaves a request in the artifact bucket with your AWS credentials.

`lgtmoose setup` suggests this as its last step. Either way, the reconciler starts the bootstrap on its next run, on the repository's installation. One bootstrap per repository can be waiting or running at a time.

### What it reads

The control task reads the merged PRs, newest first, with the App's installation token. For each one it reads the inline review comments and the bodies of submitted reviews, and keeps a comment only if all of these hold:

- its author has write access to the repository now (GitHub doesn't keep who had it when the PR merged);
- it isn't from a bot or from LGTMoose;
- it isn't a command such as `@lgtmoose learn:`;
- it's long enough to say something.

Quoted lines are dropped, the text is redacted like any learning, and a comment the [prompt-injection detector](security.md) flags is held out and counted.

The comments go in batches to the bootstrapper on the fast tier, in the sandbox. The sandbox has no GitHub token and no checkout. Each comment sits in its own untrusted block, and its author's name isn't in the prompt. The answer's schema is strict. Each candidate has a kind, a short text, an optional category and path glob, and the IDs of the comments it rests on. Nothing in it acts.

### What it stores

The post step checks every candidate:

- It must cite at least two different comments of its batch. One remark is never a rule.
- Its text must pass the prompt-injection detector.
- It must pass the write policy. An `accepted_pattern` or `scoping` learning can't name a protected category, and the text is redacted.
- It mustn't duplicate one of the repository's pending or active learnings: the same scope and text, ignoring case, spacing and punctuation.

What's left is stored as **pending**, by `lgtmoose` (permission `system`), with links to the comments it rests on. At most 50 are stored per bootstrap. Nothing is used in a review until someone with write access approves it, one at a time or with **Approve all** on the dashboard, or with `@lgtmoose approve <id>`. The usual access rules apply. Running a bootstrap again, or retrying one, stores nothing twice.

Some learnings are made without a model, from files on the default branch:

- **A lint or format config** (ESLint, Biome, Prettier, Ruff, golangci-lint, RuboCop) becomes a `scoping` learning on style: don't raise what the tool already enforces.
- **CODEOWNERS** becomes a `convention` that lists the paths with their own owners. No one's handle is copied.

### What it costs

Each batch is one fast-tier model call on up to 60 comments. A bootstrap runs as many batches as fit under `learnings.bootstrapMaxCostUsd` (5 USD by default), or the lower cap a request asks for, and stops at a PR boundary. Its batches are reserved and settled in the [spend ledger](costs.md#spend-caps) like a review's, under the repository's and the deployment's monthly caps. No PR's caps apply to it. The dashboard shows each bootstrap's PRs, comments, proposals, cost, and whether a cap stopped it.

## Learning from outcomes

LGTMoose doesn't wait for someone to write `learn:` (NIC-1081). What people do with its findings teaches it too, within the same write policy:

- **Repeated rejections.** When findings of one rule category about the same thing (their titles' key nouns overlap, as the fingerprint's fuzzy match measures it) are declined, disputed or 👎'd on `learnings.repeatThreshold` pull requests of a repository (2 by default), LGTMoose proposes a repo-wide `scoping` learning not to raise them. Its text is written in plain code from the findings and quotes the people's reasons; no model writes it. It's active at once only when every person who rejected one has write access on the repository, and pending otherwise. A protected category (`authz`, `tenant_scoping`, `money`, `secrets`) never gets one, and a pattern that already has a pending or active learning isn't proposed again. Declines and disputes count as the post step settles them, an `ignore` as it happens, and 👎 as the reconciler reads reactions.
- **`@lgtmoose remember`.** In a declined finding's thread, it makes the same kind of learning from that finding and the reason it was declined with, as the commenter's: active with write access, pending otherwise, refused for a protected category. Bots can't use it, trusted ones included.
- **Reinforcement.** The learnings in a batch's prompt are recorded with the findings it raised. When one of those findings is fixed, each of its learnings gets a hit and a `reinforced` event.
- **Not followed.** When a finding is rejected though a learning of its category was in its prompt, that learning gets a `not_followed` event. The dashboard lists active learnings that weren't followed, for a person to sharpen or retire.
- **Visible.** A review's summary says which learnings its prompts had ("Applied 3 learnings: …", with their IDs). The dashboard's Learnings page shows what was learned in the last 7 days.

```ts
// lgtmoose.config.ts
learnings: { repeatThreshold: 2 },
```

None of this changes a finding by itself: learnings stay prompt context only.

## Retrieval: learnings in reviews

The prepare step (the control task) picks each batch's learnings; the sandbox only sees their text in its prompt.

1. **Scope.** Active learnings of the PR's org: org-wide ones, and the PR's repo's whose path glob (if any) matches one of the batch's files.
2. **Rank.** With `learnings.embeddings` set to `bedrock` (Titan Text Embeddings v2 in the deployment's account) or `openai` (its embeddings API, with the key in `lgtmoose/embeddings/openai`), learnings and the batch's diff are embedded and ranked by pgvector cosine distance. A learning is embedded the first time it's ranked with a model, and the model is stored with the vector, so changing provider re-embeds rather than comparing unlike vectors. With `none` (the default), or when the provider fails, learnings are ranked by shared keywords, with no network call.
3. **Prompt.** The top 15 go in the batch's prompt after the PR and before the diff, each in an untrusted block. The prompt says a learning can't relax the rules or their severities, and never quiets a protected-category finding. Learnings are context only: no code drops or downgrades a finding because of one.
4. **Use.** Each learning put in a prompt has `hits` counted and `last_used_at` set. The reconciler retires active learnings unused for 90 days, with a `retired` event by `lgtmoose` (permission `system`), so their history stays.

The embeddings provider receives learning text and batch diffs. Only the control task can reach it: its role gets `bedrock:InvokeModel` on the one Titan model, or read access to the OpenAI key's secret. Sandbox roles get neither. `learningsForPullRequest` lists the learnings that apply to a PR, for the `learnings` command.
