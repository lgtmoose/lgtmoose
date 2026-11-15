# Commands

Commands and replies are how people steer LGTMoose on a PR. The bot's name is the GitHub App's slug, which `lgtmoose setup` sets (`lgtmoose-<org>` by default); `@lgtmoose` below stands for it.

People talk to LGTMoose by mentioning its bot (`@<app slug>`) in a PR comment or review-comment reply, one command per line. Mentions in code (fenced or inline) and in quotes (`>` lines) are ignored, and so are bots, LGTMoose included. The dispatcher holds no GitHub credential, so it forwards comment jobs to the conversation queue; the conversation Lambda reads the comment, runs its commands, reacts (👍 when every command went through, 😕 otherwise) and replies only when there's something to say. Comments without a command go to the reply judge, below.

| Command               | Who                                                                                              | What it does                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`              | the PR's author, or write access                                                                 | Queues a review of the head unless it's reviewed already. Not debounced; runs on a paused PR.                                                                                       |
| `full review`         | the PR's author, or write access                                                                 | Reviews the whole PR again, leaving earlier reviews out, unless a review of the head is running. Duplicates of posted comments are still dropped.                                   |
| `pause`, `resume`     | write access                                                                                     | Stops or restarts automatic reviews of the PR. Requested reviews still run.                                                                                                         |
| `explain`             | anyone; answered by a model for the PR's author or write access                                  | In a finding's thread, or `explain path:line`: the explainer's answer, in a later run (see below). For anyone else, or with the explainer off, the stored finding's details.        |
| `ignore`              | anyone; for blocking or protected findings, someone other than the PR's author with write access | In a finding's thread: declines it, as a person's decision.                                                                                                                         |
| `learn: <text>`       | anyone; applied at once with write access (org owner for `[org]`), else pending                  | Proposes a learning (see [Learning](learning.md)). Tags: `[path <glob>]`, `[org]`, `[kind <kind>]`, `[category <name>]`. Refused past `learnings.maxPendingPerAuthor` pending ones. |
| `approve <id>`        | write access (org owner for org-wide)                                                            | Makes one of this account's pending learnings active.                                                                                                                               |
| `learnings`           | anyone                                                                                           | Lists the learnings that apply to the PR.                                                                                                                                           |
| `forget <id>`         | write access (org owner for org-wide)                                                            | Retires one of this account's learnings.                                                                                                                                            |
| `help`, anything else | anyone                                                                                           | The list of commands.                                                                                                                                                               |

### In a review's body

Commands also work in the body of a submitted review (Comment, Approve or Request changes), with the same parser and rules: outside code and quotes, five at most, and bots and LGTMoose's own reviews ignored. The differences:

- GitHub has no reactions API for reviews, so there's no 👍 or 😕. LGTMoose always answers with a comment on the PR that mentions the review's author, saying "Done." when a command had nothing else to say.
- A review without a command is left alone. Review bodies never go to the reply judge; replies in a finding's thread do.
- `ignore`, and `explain` without `path:line`, need a finding's thread, so in a review body they say so.
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
- **`trusted_bots`**: bots are ignored, except the logins listed here adding the label or commenting `@lgtmoose review` on its own line. That's all a trusted bot can do: no other command, not `full review`, and no reply to it. LGTMoose's own bot never counts. A bot's pushes and opened PRs still start nothing.

The setting is read from the PR's base, so a PR can't change its own trigger. The prepare step decides before it clones anything, so a run that doesn't review reads no code and spends no model time. A PR that waits gets a check run titled "Waiting for a trigger" that says how to start the review: `action_required` with `gate.check_run: required` (so code nobody reviewed can't merge on it), neutral with `optional`, none with `off`. No summary comment is posted until the first review. A requested review (`review`, `full review`) always runs. A run for replies or `explain` is gated like a push: when the code waits for a trigger, the run only judges the replies and answers the explains. It reviews no code, posts no review, summary or label, and leaves the PR's last reviewed commit where it was, so the new commits stay unreviewed. A fix the judge sees then stays open, with a reply saying its file wasn't reviewed again. Its check run says the PR waits, as a push's would. A label that isn't `review.label`, or a label from a bot that isn't trusted, posts nothing. The reconciler queues a review for a PR that carries its label but whose head waited, in case the `labeled` webhook was missed. The App already receives `labeled`: it's an action of the `pull_request` event it subscribes to, so existing installs need no change.

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
