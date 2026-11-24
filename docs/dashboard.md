# Dashboard

The dashboard shows open findings, review runs, learnings, provider usage and acceptance by rule category for the repositories you can see on GitHub. You can answer findings, and approve and reject learnings, there. Members of the organizations in `allowedOrgs` sign in with GitHub; nobody else can.

It's deployed by default as the `Lgtmoose-Dashboard` stack. Set `dashboard: false` in `lgtmoose.config.ts` to leave it out. With [docker compose](compose.md), it's the `dashboard` service: see [The dashboard](compose.md#the-dashboard) there for setting it up.

## Setting it up

1. Run `pnpm lgtmoose deploy`. With the dashboard on, deploy also copies the App's OAuth client (its client ID and secret) from `lgtmoose/github-app` into `lgtmoose/github-app-oauth`, the only GitHub credential the dashboard reads.
2. Deploy prints the dashboard's URL and its **callback URL**, `https://<id>.cloudfront.net/api/auth/callback`. Add the callback URL once in the GitHub App's settings, under **Identifying and authorizing users → Callback URL**. Without it, GitHub refuses the sign-in.
3. Open the dashboard's URL and choose **Sign in with GitHub**.

The stack's outputs `DashboardUrl` and `OAuthCallbackUrl` hold the same URLs.

## What it shows

| Page               | What's on it                                                                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repositories       | Each repository you can see that LGTMoose has reviewed: open findings, blocking ones, last review                                                                                                                                                                                         |
| Open findings      | Open findings, most severe first, with the PR, file and line, and who raised them. Once shadow mode is off, findings raised in shadow mode that were never posted and nobody answered aren't listed or counted                                                                            |
| Review runs        | The latest runs: when, which PR, kind, status, files, how long, cost, and the providers they used                                                                                                                                                                                         |
| Learnings          | [Learnings](learning.md) by status: pending ones with **Approve** and **Reject**, active ones with **Reject**, and retired ones. Each shows its scope, author, source PR and use                                                                                                          |
| Learn from history | Start a [bootstrap](learning.md#starting-with-your-history) on a repository you can write to, follow the bootstraps of your repositories, and approve or reject what they proposed, each with links to the comments it rests on, one at a time or with **Approve all** and **Reject all** |
| Usage              | Each provider's batches, tokens, cost, limit hits and fallbacks in your repositories over the last 30 days, this month's estimated spend against the [spend caps](costs.md#spend-caps), and the providers sitting out a cooldown now                                                      |
| Acceptance         | The [feedback report](feedback.md)'s acceptance by rule category, and its declined findings in your repositories                                                                                                                                                                          |

Findings, runs and repositories can be filtered to one repository. Findings' and learnings' text is shown as plain text, never rendered as HTML or Markdown.

### Decisions

Each review run decides: approve, changes requested or comment, from the open findings it counted. **Review runs** shows that in a Decision column, with "(shadow)" when the run was in shadow mode and nothing was posted, and the counts of open blocking, should-fix and nit findings. A covered, superseded or failed run decided nothing and shows `—`. **Just this PR** next to a pull request lists only its runs.

A pull request's findings page starts with its latest decision, the newest run's that decided anything, with a link to all its runs: for example, "Latest decision: Changes requested (shadow) at abc1234 · 1 blocking · 2 should-fix · 0 nits · run 5eba8380". "Copy for agent" starts with the same line, as `lgtmoose findings --format md` does.

### Answering findings

**Just this PR** next to a finding opens that pull request's list of LGTMoose's findings. It shows the same findings, with the same answers, as [`lgtmoose findings`](commands.md#findings-outside-github-lgtmoose-findings):

- **Fixed** says you fixed it. That doesn't close it: the next review checks it again first and closes it only if the problem is gone. Until then it shows "Fixed: waiting for recheck by" whoever said so. A finding the recheck can't check (it isn't on a line of the pull request's new code) can't be marked fixed: decline it instead.
- **Decline** asks for your reason (up to 2,000 characters) and closes the finding at once. The reason feeds [learning from outcomes](learning.md#learning-from-outcomes), as a reply on GitHub would. A pull request's author can't decline a blocking or protected finding; someone else with write access can.
- **Copy for agent** copies the pull request's findings as markdown for a coding agent, the same as `lgtmoose findings <owner/repo>#<n> --format md`, with how to answer each one from the CLI. Where the browser doesn't allow copying, the text is shown selected to copy by hand.

The buttons show on LGTMoose's own findings in repositories you could write to when you signed in; **Fixed** only on one a recheck can check. An answer from the dashboard uses that same access from sign-in: the session keeps no GitHub token to ask again, so write access GitHub takes away still counts until you sign in again, or until the session ends (at most 8 hours). The CLI asks GitHub each time (within a minute's cache). The API checks the rest when you answer (the author rule, the finding's state, whether a recheck can check it) and says why if it doesn't take the answer.

### What was learned lately

Below the list, the Learnings page shows the learnings proposed in the last 7 days (pending or active) and the active learnings that weren't followed: a finding of their category was declined anyway though they were in its review's prompt. Sharpen one with a new learning, or reject it. See [Learning from outcomes](learning.md#learning-from-outcomes).

### Approving and rejecting learnings

**Approve** makes a pending learning active. **Reject** retires a pending or active one, like `@lgtmoose forget <id>`: its row and its history stay. Both go through the same policy as the PR commands, with you as the actor, so the `learning_events` history records your login:

- A repository or path learning needs write access or higher on that repository.
- An org-wide learning needs an owner of the org. For a user account in `allowedOrgs`, that user.

The dashboard learns your access when you sign in: the repositories listing GitHub returns for your own token includes your permission on each, and the org memberships API gives your role. Both are kept in your session. The dashboard never asks the App, so its private key stays out of the dashboard. The catch: a change on GitHub reaches the dashboard at your next sign-in, so access that was taken away lasts up to 8 hours. Signing out and in again picks up a change at once.

**Approve all** and **Reject all** on the **Learn from history** page do the same for each pending learning a bootstrap proposed, one at a time through the policy: each gets its own event, and those you don't have the access for stay pending and are counted as refused. Asking for a bootstrap needs write access to the repository, as GitHub said at sign-in, since it spends model time.

### Usage and acceptance

- Usage counts batches in your repositories only. This month's spend is shown per repository, against `budgets.perRepoMonthlyUsd`; the deployment's total, against `budgets.monthlyUsd`, only to an owner of one of the deployment's orgs. A repository's own lower caps in `.lgtmoose.yaml` aren't shown. Cooldowns apply to every review in the deployment, so everyone signed in sees them.
- The acceptance numbers per category cover every repository LGTMoose reviews, as the reconciler's report does; the dashboard can't split them by repository. Its list of declined findings shows only those in your repositories. Without a report yet (the reconciler writes one each day), the page says so.

## How sign-in works

- The dashboard is one CloudFront distribution: the page from a private S3 bucket, and its API at `/api/*`. The browser only ever talks to that one origin, so there's no CORS and the session cookie is first-party.
- **Sign in with GitHub** uses the App's OAuth with a `state` value and PKCE. The code GitHub sends back is exchanged by the dashboard API, with the client secret, never in the browser.
- With your GitHub token, the API checks that you're an active member of an allowed org (for a user account in `allowedOrgs`, that you're that user) and whether you own it, and lists the repositories you can see through the App's installations there, with your permission on each. Then it drops the token: it's never stored or sent to the browser.
- You get a session for 8 hours, or less if GitHub's token expires sooner. The browser keeps a random token in an HttpOnly, Secure, SameSite=Lax cookie (`__Host-lgtmoose_session`); the database keeps only its SHA-256, with your login, orgs, the orgs you own, your repositories and the ones you can write to. Signing out deletes it.
- Every API answer is limited to the repositories you could see at sign-in. A repository you can't see answers "not found".

## Security

- The dashboard API is its own Lambda, separate from the internet-facing webhook gateway. It can read the database, `lgtmoose/github-app-oauth`, a signing key the stack generates, and one object in the artifact bucket: the feedback report, `reports/feedback/latest.json`. It can't read the App's private key, the webhook secret, any model credential, transcripts or anything else in that bucket.
- Requests that change anything (signing out, approving and rejecting learnings, answering a finding) must be POSTs from the dashboard's own origin (`Origin`, and `Sec-Fetch-Site` when the browser sends it), with the session cookie.
- The API also serves [`lgtmoose findings`](commands.md#findings-outside-github-lgtmoose-findings) and [`lgtmoose runs`](commands.md#a-pull-requests-runs-lgtmoose-runs): a pull request's findings list, answers to them, and its runs, with the person's GitHub token in an `x-lgtmoose-github-token` header instead of a session. Only those three endpoints take one, and only for one pull request, and a request with a token never reads the session cookie. GitHub says whose token it is and what they can do on the repository, and answering also needs a token GitHub shows can write (the `repo` scope). As at sign-in, a token sees only repositories of an allowed org its person is an active member of (or their own account's), so it must be able to read that membership (`read:org`, or a fine-grained token's Members permission); reading a public repository isn't enough. The token is never stored or logged. A token that isn't shaped like one, or an installation token (`ghs_`), is refused without asking GitHub. By the token's hash, a token GitHub refused is refused again for ten minutes without asking, and a verified login is kept for an hour after its last use; membership and permissions are read again after a minute. These caches are per Lambda instance (or per compose server), and nothing caps lookups across them: the abuse limit is API Gateway's throttle (compose: the server's rate limit). The remaining risk is that a flood of distinct bad tokens, within that throttle, makes as many `/user` calls to GitHub from the dashboard's address.
- A learning outside your repositories and orgs answers "not found", whether or not it exists.
- CloudFront sends these headers on every response: a Content-Security-Policy that allows scripts, styles and connections only from the dashboard itself and no framing, HSTS for two years, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- The API is throttled to 10 requests a second (bursts of 20).

Under docker compose, one Node server sends the same headers and does the same checks, with the same rate limit per client address. It holds a database login of its own, which can read reviews and change only its sessions, learnings' status and the answers to findings, and reads the feedback report through a view of that one artifact. It has the OAuth client and its signing key, in a secrets directory of its own, and no Docker socket or App private key. See [The dashboard](compose.md#the-dashboard).

See [Security](security.md) and the threat model in `SECURITY.md`.

## Known limits

- What you can see and change is fixed at sign-in: someone removed from the org or a repository, or whose write access or ownership is taken away, keeps what their session shows and can still approve and reject there for up to 8 hours. Sign-out ends it at once; there's no way yet to end someone else's session except deleting their rows from `dashboard_sessions`.
- A person with a session sees every open finding in their repositories, including its text, as they would on GitHub.
- Only repositories of the App's installations on allowed orgs are listed, at most 2000 per person.
- On AWS, the dashboard's API Gateway URL is reachable directly too, but browsers never send the session cookie there.
- On AWS there's no custom domain yet: the dashboard is at its `cloudfront.net` address. Under docker compose it's at `DASHBOARD_ORIGIN`, behind your reverse proxy.
- Runs show their providers only where usage was recorded; otherwise "—".
- Acceptance by category is deployment-wide, not per repository (see above). Its per-category numbers say nothing about any one repository's findings.
- The learnings page shows the newest 200 learnings of a status, without paging.
- `lgtmoose destroy` leaves `lgtmoose/github-app-oauth` in Secrets Manager, like the App's other secrets.
