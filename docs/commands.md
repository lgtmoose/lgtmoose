# Commands

Commands and replies are how people steer LGTMoose on a PR. The bot's name is the GitHub App's slug, which `lgtmoose setup` sets (`lgtmoose-<org>` by default); `@lgtmoose` below stands for it.

People talk to LGTMoose by mentioning its bot (`@<app slug>`) in a PR comment or review-comment reply, one command per line. Mentions in code (fenced or inline) and in quotes (`>` lines) are ignored, and so are bots, LGTMoose included. The dispatcher holds no GitHub credential, so it forwards comment jobs to the conversation queue; the conversation Lambda reads the comment, runs its commands, reacts (👍 when every command went through, 😕 otherwise) and replies only when there's something to say. Comments without a command go to the reply judge, below.

| Command               | Who                                                                                              | What it does                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`              | the PR's author, or write access                                                                 | Queues a review of the head unless it's reviewed already. Not debounced; runs on a paused PR.                                                                                                                                                                                                               |
| `full review`         | the PR's author, or write access                                                                 | Reviews the whole PR again, leaving earlier reviews out, unless a review of the head is running. Duplicates of posted comments are still dropped. Our open blocking and should-fix findings are checked again, wherever the fix is (see [When threads are resolved](#when-lgtmooses-threads-are-resolved)). |
| `pause`, `resume`     | write access                                                                                     | Stops or restarts automatic reviews of the PR. Requested reviews still run.                                                                                                                                                                                                                                 |
| `explain`             | anyone; answered by a model for the PR's author or write access                                  | In a finding's thread, or `explain path:line`: the explainer's answer, in a later run (see below). For anyone else, or with the explainer off, the stored finding's details.                                                                                                                                |
| `ignore`              | anyone; for blocking or protected findings, someone other than the PR's author with write access | In a finding's thread: declines it, as a person's decision.                                                                                                                                                                                                                                                 |
| `remember`            | anyone; applied at once with write access, else pending                                          | In a declined finding's thread: learns not to raise findings like it in this repository (see [Learning from outcomes](learning.md#learning-from-outcomes)). Never for protected categories.                                                                                                                 |
| `learn: <text>`       | anyone; applied at once with write access (org owner for `[org]`), else pending                  | Proposes a learning (see [Learning](learning.md)). Tags: `[path <glob>]`, `[org]`, `[kind <kind>]`, `[category <name>]`. Refused past `learnings.maxPendingPerAuthor` pending ones.                                                                                                                         |
| `approve <id>`        | write access (org owner for org-wide)                                                            | Makes one of this account's pending learnings active.                                                                                                                                                                                                                                                       |
| `learnings`           | anyone                                                                                           | Lists the learnings that apply to the PR.                                                                                                                                                                                                                                                                   |
| `forget <id>`         | write access (org owner for org-wide)                                                            | Retires one of this account's learnings.                                                                                                                                                                                                                                                                    |
| `help`, anything else | anyone                                                                                           | The list of commands.                                                                                                                                                                                                                                                                                       |

### Your App's handle

Commands use your App's own handle: for an App called `lgtmoose-acme`, that's `@lgtmoose-acme review`. `lgtmoose setup` prints the handle when it's done, and `help`, the wrong-handle hint and the summary comment's footer show it too. When neither the slug nor an alias is known, the footer leaves the pointer out.

To make the `@lgtmoose` these docs use work as well, add it as an alias in `lgtmoose.config.ts` and deploy again:

```ts
commandAliases: ["lgtmoose"],
```

Up to five aliases are allowed, each shaped like a GitHub login. A handle never changes what a command may do: that depends on who wrote the comment, as GitHub reports it. An alias is also a GitHub login, so GitHub notifies whoever owns it, and the `lgtmoose` organization owns `@lgtmoose`.

Without that alias, a comment that mentions `@lgtmoose` followed by a whole command gets one reply on the PR: "Commands here use `@lgtmoose-acme`, not `@lgtmoose`."

A whole command means the command and nothing else on the line, as the parser reads it: `@lgtmoose review`, `@lgtmoose help`, `@lgtmoose approve <id>`, or `@lgtmoose learn: <text>`. These get no hint:

- a thanks or a cc, such as "Thanks @lgtmoose!";
- a sentence that only starts with a command word, such as "@lgtmoose help me see why this is null".

The reply:

- is posted once per PR;
- carries the reply marker, so nothing reads it as a command;
- is only logged in shadow mode;
- can still come from a later comment if posting it fails, or from a retry of the same comment, after two minutes, if the Lambda stopped before posting it.

Rarely, a PR gets the hint twice: an attempt posts it but stops before recording that, and its retry posts it again. That's accepted, as the hint is only a courtesy. The comment that got the hint is never given a 😕.

The comment itself runs nothing. What else happens to it depends on where it is:

- **As a reply in the thread of one of LGTMoose's findings that's still open or outdated:** it still goes to the reply judge, since the person may be answering the finding. On a finding that's fixed, declined or resolved, it's treated as anywhere else.
- **Anywhere else:** it isn't sent anywhere. After the PR has had its hint, later ones get a 😕. A submitted review's body gets no 😕, because GitHub reviews take no reactions, so that one is only logged.

The hint assumes that no other App called `lgtmoose` answers on your repositories. If one does, turn it off with `commandHint: false`. A comment like that is then handled as before, so in a finding's thread it goes to the reply judge.

### In a review's body

Commands also work in the body of a submitted review (Comment, Approve or Request changes), with the same parser and rules: outside code and quotes, five at most, and bots and LGTMoose's own reviews ignored. The differences:

- GitHub has no reactions API for reviews, so there's no 👍 or 😕. LGTMoose always answers with a comment on the PR that mentions the review's author, saying "Done." when a command had nothing else to say.
- A review without a command is left alone. Review bodies never go to the reply judge; replies in a finding's thread do.
- `ignore`, `remember`, and `explain` without `path:line`, need a finding's thread, so in a review body they say so.
- A redelivered review runs its commands once: the conversation queue dedupes on the review's ID, and a `review` it asks for is keyed by it too (`command-review-<id>-review`).
- Edited and dismissed reviews, and reviews with an empty body, are ignored. Editing a review doesn't rerun its commands.
- A learning proposed from a review body records no source comment, so the per-comment guard against proposing the same learning twice doesn't cover a review redelivered after the queue's five-minute dedupe window. The per-author pending limit still bounds it.

## When reviews run

By default a PR is reviewed when it's opened, marked ready, or pushed to (each push waits `reviewDebounceSeconds`, a minute by default, so a burst of pushes is reviewed once). Drafts and PRs labelled `skip-lgtmoose` are never reviewed. A team whose PRs go through many work-in-progress pushes, or whose PRs are written by coding agents, can review only when a PR is ready instead, in `.lgtmoose.yaml`:

```yaml
review:
  trigger: label # auto (the default), label, or command
  on_push: manual # after the first review, a push waits for the label or a command
  label: lgtmoose:review
  label_once: true # the label comes off as its review starts; add it again for the next round
  trusted_bots: [claude[bot]] # agents whose label or `@lgtmoose review` counts
```

- **`trigger: label`**: a PR is reviewed only while it carries `review.label`. Adding the label starts a review; a push to a labelled PR is reviewed as usual.
- **`trigger: command`**: only `@lgtmoose review` (or `full review`) starts one.
- **`on_push: manual`**: the first review runs as the trigger says; after it, a push waits until the label is added again or someone comments `@lgtmoose review`.
- **`auto_pause_after`**: after this many automatic reviews of one pull request (1 to 50), later pushes wait. A review that failed, or one a spend cap stopped, does not count. Reviews that already ran count, so a pull request already past the limit waits on its next push. Unset, they never pause this way. `@lgtmoose review`, `full review` and `resume` start the count over. The review someone asked for does not count, including the run that starts once its checks pass. A later push does. The waiting check run says how many ran and how to continue.
- **`trusted_bots`**: bots are ignored, except the logins listed here adding the label or commenting `@lgtmoose review` on its own line. That's all a trusted bot can do: no other command, not `full review`, and no reply to it. LGTMoose's own bot never counts. A bot's pushes and opened PRs still start nothing.

The setting is read from the PR's base, so a PR can't change its own trigger. The prepare step decides before it clones anything, so a run that doesn't review reads no code and spends no model time. A PR that waits gets a check run titled "Waiting for a trigger" that says how to start the review: `action_required` with `gate.check_run: required` (so code nobody reviewed can't merge on it), neutral with `optional`, none with `off`. No summary comment is posted until the first review. A requested review (`review`, `full review`) always runs. A run for replies or `explain` is gated like a push: when the code waits for a trigger, the run only judges the replies and answers the explains. It reviews no code, posts no review, summary or label, and leaves the PR's last reviewed commit where it was, so the new commits stay unreviewed. A fix the judge sees then stays open, with a reply saying its file wasn't reviewed again. Its check run says the PR waits, as a push's would. A label that isn't `review.label`, or a label from a bot that isn't trusted, posts nothing. The reconciler queues a review for a PR that carries its label but whose head waited, in case the `labeled` webhook was missed. The App already receives `labeled`: it's an action of the `pull_request` event it subscribes to, so existing installs need no change.

### Waiting for CI

A review can also wait until the PR's CI passes, so model time isn't spent on code that's about to change:

```yaml
review:
  wait_for_checks: required # off (the default), required, or a list of check names
  wait_timeout_minutes: 60 # how long to wait for checks that haven't finished
```

- **`required`** waits for the base branch's required status checks: those its rulesets require, and those its classic branch protection requires. Both are read without the `administration` permission (the rules API, and "Get a branch"). A branch that requires none doesn't wait.
- **A list**, such as `[build, test]`, waits for the check runs or commit statuses with those names.
- LGTMoose's own check is never one it waits for, even when it's required.

The wait comes after the trigger: with `trigger: label`, adding the label starts the wait, and the review runs once CI is green. Then:

- **All passed** (success, neutral or skipped): the review starts.
- **One failed**: the review waits until it passes, however long that takes. Its check run, "Waiting for CI to pass", names the failed checks.
- **Some still running**: the check run, "Waiting for CI", names them. After `wait_timeout_minutes` (5 to 1440) since the wait began, the review starts anyway, and its summary says it didn't wait and for which checks.
- **`@lgtmoose review`** from someone with write access, by GitHub's collaborators API, starts the review at once. From the PR's author without write access, or from a trusted bot, it waits for CI like a push.
- **A push** during the wait starts it again for the new head.

The waiting check runs are `action_required`, `neutral` or absent by `gate.check_run`, as for a trigger. A run for replies or `explain` on a waiting PR only judges and explains, as above. Spend caps apply once the review starts.

While a PR waits, the dispatcher keeps which head it waits on. A check suite finishing on that head, or a commit status on that commit, starts a short run that reads the checks again, after 20 seconds so a burst of finishing checks is read once. A check run is not its own webhook: the suite covers its jobs. A status names no pull request, so every open pull request of that repository waiting on the commit is woken. A check on any other head, or on a PR that doesn't wait, is dropped after one database read. GitHub names no PR in a fork's check events, and a status posted on the fork's repository is not the commit the base repository waits on: the reconciler checks every waiting PR again each interval, at most every five minutes, which also starts a review whose wait timed out. A named check that passes while other jobs in the same suite are still running is noticed when that suite completes, or by the reconciler. A different suite completing still wakes the wait. A wait on a failed check is checked again by the reconciler only within its lookback window; the webhook of the check's re-run is what normally ends it.

Who sent a command, and their access, come from GitHub (the comment's author, the collaborators API and the org memberships API), never from the comment's text. Replies escape whatever they repeat (finding titles, learning text), so a reply can't mention people or carry links it was fed. In shadow mode the Lambda writes nothing to GitHub and logs the reaction and reply instead; state changes (pause, learnings, declines) still apply.

## `explain`: the explainer

`explain` on one open or outdated finding, from the PR's author or someone with write access, is answered by a model on the reply judge's path. The conversation Lambda records the request in `pending_replies` (`kind` `explain` in the finding's thread, `explain_pr` for `explain path:line`), reacts 👍 and queues a run (`requested: "explain"`, which runs on a paused PR, since a person asked). The run's prepare step takes up to `maxExplanations` (5) pending explains of the PR, each finding's latest only, and adds one explainer batch per finding on the fast tier: the finding and the code around its line, each in an untrusted block. The sandbox task runs it with the checkout, no GitHub token and only its provider's leased credential. Its output is strict (`explanationSchema`: a short text and an optional line at head) and has no field that does anything.

The post step runs the prompt-injection detector over the answer and posts it escaped (no mentions, no links) in the finding's thread, or on the PR for `explain path:line`, with the reply marker. The answer, or that it was flagged, is kept under the head's keys (`runs/heads/<repo>/<pr>/<head>/explanations/<finding>.json`), so the model runs at most once per finding per head and later `explain`s there reuse it. A flagged answer, a failed or missing one (the model unavailable, say), `explain` from anyone else, on several findings at one line, or with `maxExplanations` set to 0 gets the stored finding's details, as before. The reconciler asks again for a run for an explain no run took after 30 minutes. `explain path:line` in a submitted review's body has no comment to record the request by, so its reply has the stored finding's details.

## Replies on findings: the reply judge

A person's reply on one of LGTMoose's open findings' review threads (not a command, not thanks or an emoji) is recorded in `pending_replies`, redacted like learning text, and the conversation Lambda queues a run for it (`requested: "replies"`; none on a paused PR). The model doesn't run in the Lambda, which has no model credential: the run is an ordinary review run, so the judge runs in a sandbox task with only its provider's credential (leased through the credential broker) and no GitHub token, reading the checkout at head. Each run, the prepare step takes up to `maxReplyJudgements` (10) pending replies, each finding's latest only, and adds one judge batch per reply on the fast tier. The post step acts on the judgements before the decision, then writes replies and resolves threads once it holds its claim; a run someone asked for (a full review, or one for replies) is never covered by the head's earlier review, so the decision, check run, summary and label are recomputed. The reconciler asks for a run again for a reply no run took after 30 minutes, and `comments_through` now moves as comments are handled, so the reconciler's missed-comment path works.

The judge only classifies (fixed, declined, disputed, question or other) and writes a few words; plain code decides (`decideReply`):

| Reply    | What happens                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fixed    | Closed as fixed, and its thread resolved, only when the judge read the code at head and found the problem gone **and** git shows the finding's file changed since it was raised. A claim alone never clears it. Otherwise one reply naming the line where it still is.         |
| declined | Declined and resolved, with a learning proposed (through the learnings policy) when the judge saw a general rule. A blocking or protected finding needs someone other than the PR's author with write access, as for resolving its thread; otherwise one reply saying who can. |
| disputed | Re-checked by the judge. Still valid: one reply with the evidence, never a second on the same finding. Wrong: a should_fix or nit is closed as disputed; a blocking or protected one stays open with one reply.                                                                |
| question | One short answer.                                                                                                                                                                                                                                                              |

At most one reply per finding per run, never a thank-you, and each with a marker so it's never read as a command or judged. A person unresolving a thread LGTMoose resolved reopens the finding. Top-level PR comments aren't judged.

## When LGTMoose's threads are resolved

LGTMoose resolves the thread of one of its own findings, with a reply saying "This looks fixed at `<sha>`" and why, when a review checks the finding again and the code at head shows the problem is gone. That happens on:

- **an incremental review**, for open blocking and should-fix findings whose file, or a related file, the new commits changed;
- **a full review** (`full review`), for every open blocking and should-fix finding, wherever the fix is;
- **either review**, for a finding of any severity, nits included, whose cited line was edited or deleted (committing one of LGTMoose's suggestions is one way). It's `outdated` and no longer counts towards the decision; now its thread is resolved too when the edit fixed it.

Findings someone said are fixed with `lgtmoose findings ack` (below) are checked first, then open blocking findings, then open should-fix, then outdated ones, oldest first, at most 10 a run. A finding is closed only when this run's review didn't raise it again, and in a protected category (`authz`, `tenant_scoping`, `money`, `secrets`) only when the check names the file with the fix by its full path. On a full review, and for an outdated finding, this run's review must also have read its file. On an incremental review, an open finding whose file this review didn't change can close on the check alone, since its fix is in another file; one whose file the review changed must have been reviewed. After a force-push that dropped the commit a protected finding was raised at, a full review keeps it open. A finding on a file the PR no longer changes isn't checked. When the check finds the problem still there, or can't tell, the thread stays unresolved, and an outdated finding stays outdated. A thread is also resolved when the reply judge accepts a "fixed" reply (above). LGTMoose never resolves other reviewers' threads, and leaves a finding a person closed as it is. In shadow mode the reply and the resolve are logged instead.

## Findings outside GitHub: `lgtmoose findings`

In shadow mode a finding has no thread to reply in. `lgtmoose findings` lists a pull request's open findings and answers them through the deployment's dashboard API, in shadow mode or live. It posts nothing to GitHub.

```bash
pnpm lgtmoose findings acme/shop#42 --format md
```

The `md` format is written for a coding agent: paste it into the agent's prompt. It lists each of LGTMoose's open findings, and outdated ones (whose line has changed), with its ID, severity, `path:line` and text, quotes each finding's text as data rather than instructions, and says how to answer each one. `--format json` and `--format text` are there too. Other reviewers' findings aren't listed: they're on GitHub, and answered there.

```bash
pnpm lgtmoose findings ack <id> fixed
pnpm lgtmoose findings ack <id> declined --reason "The note is kept by the caller."
```

| Answer   | What it does                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fixed    | Doesn't close the finding, and doesn't make it checked: the next review picks it by the same changed-file rules as any other, checks it first when it does, and closes it only by the rules above (a protected one only when the check names the file with the fix). Once the check has looked, the claim is cleared. Only a finding on a line of the PR's new code can be marked; another can only be declined. |
| declined | Closes it, with the reason, as an accepted decline on its thread would: it no longer counts towards the decision, it counts as declined in [Feedback signals](feedback.md), and the reconciler's next run learns from it as from a decline on GitHub. A blocking or protected finding can't be declined by the PR's author; someone else with write access can.                                                  |

- **Who may:** the command sends your GitHub token (from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`) in its own header, and never follows a redirect with it. The dashboard API asks GitHub who you are and what you can do on the repository. As for signing in to the dashboard, you must be an active member of the allowed org that owns it (or it's your own account's): then reading it lists its findings. A classic token needs `read:org` for GitHub to show the membership; `gh auth token` has it. An installation token (`ghs_…`) isn't a person's and is refused. Answering needs write access (push, maintain or admin) **and** a token that can write: a classic or OAuth token with the `repo` scope (`public_repo` on a public repository). `gh auth token` is one. GitHub doesn't report a fine-grained token's permissions, so one can list findings but not answer them. The repository's owner must be in `allowedOrgs`. The token is never stored or logged; GitHub's answer is kept for a minute, and a token GitHub refused is refused again for ten minutes without asking. After ten failed sign-ins from one address in ten minutes (or a hundred in all), the API answers 429 until the window ends.
- **When GitHub says no:** a token not authorized for the organization's SAML single sign-on gets a 403 saying so; GitHub being unreachable or busy is a 503, and the command says to try again, as is GitHub's rate limit.
- **Where:** the dashboard's URL comes from `--url`, `LGTMOOSE_DASHBOARD_URL`, or the deployed `Lgtmoose-Dashboard` stack. Under docker compose, use the dashboard's local address, such as `http://localhost:8080`. The dashboard must be deployed (`dashboard: true`, the default).
- **Reasons are untrusted:** a decline's reason is stored as a reply's body is, and handled the same way where it reaches a learning proposal.
