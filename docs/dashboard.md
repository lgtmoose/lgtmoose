# Dashboard

The dashboard shows open findings and review runs for the repositories you can see on GitHub. Members of the organizations in `allowedOrgs` sign in with GitHub; nobody else can.

It's deployed by default as the `Lgtmoose-Dashboard` stack. Set `dashboard: false` in `lgtmoose.config.ts` to leave it out.

## Setting it up

1. Run `pnpm lgtmoose deploy`. With the dashboard on, deploy also copies the App's OAuth client (its client ID and secret) from `lgtmoose/github-app` into `lgtmoose/github-app-oauth`, the only GitHub credential the dashboard reads.
2. Deploy prints the dashboard's URL and its **callback URL**, `https://<id>.cloudfront.net/api/auth/callback`. Add the callback URL once in the GitHub App's settings, under **Identifying and authorizing users → Callback URL**. Without it, GitHub refuses the sign-in.
3. Open the dashboard's URL and choose **Sign in with GitHub**.

The stack's outputs `DashboardUrl` and `OAuthCallbackUrl` hold the same URLs.

## What it shows

| Page          | What's on it                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Repositories  | Each repository you can see that LGTMoose has reviewed: open findings, blocking ones, last review  |
| Open findings | Open findings, most severe first, with the PR, file and line, and who raised them                  |
| Review runs   | The latest runs: when, which PR, kind, status, files, how long, cost, and the providers they used  |

Each page can be filtered to one repository. Findings' text is shown as plain text, never rendered as HTML or Markdown.

Not built yet: the pending learnings queue (approve and reject), the learnings list, provider usage and limit hits, and acceptance by rule category ([Feedback signals](feedback.md) has those numbers in its report). They come in a follow-up PR.

## How sign-in works

- The dashboard is one CloudFront distribution: the page from a private S3 bucket, and its API at `/api/*`. The browser only ever talks to that one origin, so there's no CORS and the session cookie is first-party.
- **Sign in with GitHub** uses the App's OAuth with a `state` value and PKCE. The code GitHub sends back is exchanged by the dashboard API, with the client secret, never in the browser.
- With your GitHub token, the API checks that you're an active member of an allowed org (for a user account in `allowedOrgs`, that you're that user), and lists the repositories you can see through the App's installations there. Then it drops the token: it's never stored or sent to the browser.
- You get a session for 8 hours, or less if GitHub's token expires sooner. The browser keeps a random token in an HttpOnly, Secure, SameSite=Lax cookie (`__Host-lgtmoose_session`); the database keeps only its SHA-256, with your login, orgs and repositories. Signing out deletes it.
- Every API answer is limited to the repositories you could see at sign-in. A repository you can't see answers "not found".

## Security

- The dashboard API is its own Lambda, separate from the internet-facing webhook gateway. It can read the database, `lgtmoose/github-app-oauth` and a signing key the stack generates. It can't read the App's private key, the webhook secret or any model credential.
- Requests that change anything (today, only signing out) must come from the dashboard's own origin (`Origin`, and `Sec-Fetch-Site` when the browser sends it).
- CloudFront sends these headers on every response: a Content-Security-Policy that allows scripts, styles and connections only from the dashboard itself and no framing, HSTS for two years, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- The API is throttled to 10 requests a second (bursts of 20).

See [Security](security.md) and the threat model in `SECURITY.md`.

## Known limits

- What you can see is fixed at sign-in: someone removed from the org or a repository keeps what their session shows for up to 8 hours.
- A person with a session sees every open finding in their repositories, including its text, as they would on GitHub.
- Only repositories of the App's installations on allowed orgs are listed, at most 2000 per person.
- The dashboard's API Gateway URL is reachable directly too, but browsers never send the session cookie there.
- There's no custom domain yet: the dashboard is at its `cloudfront.net` address.
- Runs show their providers only where usage was recorded; otherwise "—".
- `lgtmoose destroy` leaves `lgtmoose/github-app-oauth` in Secrets Manager, like the App's other secrets.
