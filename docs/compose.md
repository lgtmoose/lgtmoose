# docker compose

LGTMoose on one host, without AWS: a gateway, one or more runners, an egress proxy, Postgres and
optionally the dashboard, in
[deploy/compose/compose.yaml](https://github.com/lgtmoose/lgtmoose/blob/main/deploy/compose/compose.yaml). Reviews behave as on AWS. The
same code runs, with Postgres in place of SQS, S3 and Step Functions, and one Docker container
per batch in place of a Fargate task.

Read [The Docker socket](#the-docker-socket) before you run it.

## What runs

| Service        | Does                                                                                                       | Reaches                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `gateway`      | Verifies GitHub's webhooks and queues jobs                                                                 | The internet (inbound, on `GATEWAY_PORT`), Postgres as a login that may only add jobs                    |
| `runner`       | The dispatcher, the review workflow, prepare and post, `@lgtmoose` commands and replies, and the schedules | Postgres, GitHub, the secrets directory, the Docker socket                                               |
| `dashboard`    | The [dashboard](dashboard.md)'s page and API, on one origin. Optional: the `dashboard` profile             | The internet (inbound, on `DASHBOARD_PORT`, and GitHub), Postgres as its own login, `secrets/dashboard/` |
| `egress-proxy` | Lets sandboxes reach the model APIs in `LGTMOOSE_EGRESS_HOSTS`, and nothing else                           | The internet (outbound), the sandbox network                                                             |
| sandboxes      | One per batch, started and removed by the runner: run the reviewer on that batch                           | The sandbox network only: the egress proxy is their one way out                                          |
| `postgres`     | Jobs, runs, findings, learnings, artifacts                                                                 | The internal database network only                                                                       |

On a schedule, the runners also:

- run the reconciler every `reconcileIntervalMinutes`, with retiring unused learnings and reading feedback;
- check the stored credentials every 6 hours;
- once a day, delete artifacts and ended runs older than 30 days, as the S3 lifecycle rule does on AWS.

With several runners, each of these runs on one of them at a time, about once per interval
between them (see [More than one runner](#more-than-one-runner)).

## Setting it up

You need Docker with the compose plugin, a GitHub App (`lgtmoose setup` creates one; you need
its App ID, private key and webhook secret), and a credential for each provider.

1. In `deploy/compose`, copy the examples and fill them in:

   ```bash
   cp .env.example .env
   ```

   ```bash
   cp lgtmoose.config.example.json lgtmoose.config.json
   ```

   The config is the same as `lgtmoose.config.ts` for AWS (see [configuration](configuration.md)),
   as JSON. `region` is required but unused here. Bedrock and Vertex providers, and Bedrock
   embeddings, need a cloud account and are refused: use an API key or plan token.

2. Put the secrets in `deploy/compose/secrets/`, one file each, readable only by you. A secret's
   file is its name with `/` written as `__`:

   | File                           | Holds                                                                                             |
   | ------------------------------ | ------------------------------------------------------------------------------------------------- |
   | `lgtmoose__github-app`         | JSON: `{ "appId": 123, "privateKey": "-----BEGIN RSA PRIVATE KEY-----…" }`                        |
   | `lgtmoose__provider__<id>`     | Each provider's credential, as `lgtmoose auth` would store it (see [credentials](credentials.md)) |
   | `lgtmoose__tickets__linear`    | The Linear API key, if `tickets.provider` is `linear`                                             |
   | `lgtmoose__embeddings__openai` | The OpenAI key, if `learnings.embeddings.provider` is `openai`                                    |

   ```bash
   chmod 700 secrets
   ```

   ```bash
   chmod 600 secrets/*
   ```

   The runner's user (uid 10001) must be able to read them, and write them for a ChatGPT
   sign-in, whose refreshed `auth.json` is stored back. Either `chown 10001` the directory and
   files, or run the runner as your own user.

3. Set `LGTMOOSE_EGRESS_HOSTS` to what your config needs, and `DOCKER_GID` to the socket's group:

   ```bash
   docker compose run --rm --no-deps --entrypoint node runner /app/dist/local/egress-hosts.js
   ```

   ```bash
   stat -c %g /var/run/docker.sock
   ```

   The runner refuses to start when `LGTMOOSE_EGRESS_HOSTS` doesn't match the config, so a
   provider added later can't fail every review quietly.

4. Build and start it:

   ```bash
   docker compose --profile build build
   ```

   ```bash
   docker compose up -d
   ```

   The runner applies the database migrations and creates the gateway's login on every start.

5. Point the App's webhook URL at `https://<your host>/webhooks/github` (see below).

Shadow mode is the default, as on AWS: reviews are recorded in the database, not posted, until
`"shadow": false` is in the config.

## Webhooks: a reverse proxy or a tunnel

GitHub has to reach the gateway over HTTPS. The gateway listens on `GATEWAY_BIND:GATEWAY_PORT`,
`127.0.0.1:3000` by default, so it isn't reachable from outside on its own:

- **A reverse proxy on the host** (Caddy, nginx, Traefik) terminates TLS and forwards
  `/webhooks/github` to `127.0.0.1:3000`. Set `TRUST_PROXY_HOPS=1`.
- **A tunnel** (Cloudflare Tunnel, ngrok, Tailscale Funnel) forwards a public HTTPS URL to
  `127.0.0.1:3000`. Set `TRUST_PROXY_HOPS=1`.
- **Directly**: set `GATEWAY_BIND=0.0.0.0` only with TLS in front some other way, and
  `TRUST_PROXY_HOPS=0`. With 0, a caller can't choose the client IP the gateway logs and
  rate-limits by through its own `X-Forwarded-For`; with more hops than you really have, it can.

Every delivery is checked against `GITHUB_WEBHOOK_SECRET` before anything else, so an exposed
gateway refuses forged webhooks either way.

## The dashboard

The [dashboard](dashboard.md) runs as the `dashboard` service: one Node server for the page and
its API, on one origin, with the same sign-in, sessions and checks as on AWS. It's in the
`dashboard` profile, so it starts only when you ask for it.

1. In the GitHub App's settings, note its **Client ID** and generate a **client secret**, and add
   the callback URL `https://<your dashboard host>/api/auth/callback` under **Identifying and
   authorizing users → Callback URL**.

2. Put the OAuth client in a directory of the dashboard's own, `secrets/dashboard/`. It sees
   only this directory: not the App's private key or any other secret.

   ```bash
   mkdir -p secrets/dashboard
   ```

   The file `secrets/dashboard/lgtmoose__github-app-oauth` holds JSON:
   `{ "clientId": "Iv1.…", "clientSecret": "…" }`. Then `chmod 700` the directory, `chmod 600`
   the file, and `chown 10001` both, as for `secrets/`: on its first start the dashboard
   generates its session signing key and stores it there, as
   `lgtmoose__dashboard-signing-key`. Delete that file to sign everyone out at the next start.

3. In `.env`, set `DASHBOARD_DB_PASSWORD` (16+ characters) and `DASHBOARD_ORIGIN`, the https
   address people open it at, without a path: `https://lgtmoose.example.com`. Sign-in redirects
   there, and changes are accepted only from it.

4. Start it with the others:

   ```bash
   docker compose --profile dashboard up -d
   ```

   The runner creates the dashboard's database login at start, so restart the runner if you
   set `DASHBOARD_DB_PASSWORD` after it started.

5. Point your reverse proxy's dashboard host at `DASHBOARD_BIND:DASHBOARD_PORT`,
   `127.0.0.1:3001` by default, over HTTPS, and set `TRUST_PROXY_HOPS` as for the gateway. The
   session cookie is `__Host-` and `Secure`, so the dashboard works over HTTPS only.

What it can do:

- **Its database login** (`lgtmoose_dashboard`) reads pull requests, findings, review runs,
  provider use and cooldowns, learnings and the spend ledger; creates, reads and deletes its own
  sessions; and
  approves or retires a learning (`status`, `updated_at` and `retired_at` on `learnings`, and a
  new `learning_events` row). It can ask for a [bootstrap from review history](learning.md#starting-with-your-history)
  (SELECT and INSERT on `learning_bootstraps`, and SELECT on `learning_bootstrap_items`), but not
  change one once asked. It reads the feedback report through a view of that one artifact:
  not the `artifacts` table, which holds transcripts and run data. It can answer a finding for
  [`lgtmoose findings ack`](commands.md#findings-outside-github-lgtmoose-findings) only through
  two SECURITY DEFINER functions, `lgtmoose_claim_fix` and `lgtmoose_decline_finding`, which
  allow just those transitions on LGTMoose's own open or outdated findings; it can't write
  `findings` or `finding_events` itself.
  It can't read the job queue or executions, change runs, or delete anything but sessions.
- **No Docker socket and no App private key.** The OAuth client and its signing key are the
  only secrets it holds. It also mounts `lgtmoose.config.json` read-only, for the
  [spend caps](costs.md#spend-caps) on the Usage page; the config holds no secrets. Who may approve or reject a learning is decided as on AWS, from what
  GitHub said about the person at sign-in.
- **The same headers as CloudFront sends** on every response, the page and the API: the same
  Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. Only `GET` and `POST` reach the API, at 10 requests a second
  (bursts of 20) per client address, the address `TRUST_PROXY_HOPS` says to trust.

## More than one runner

Several runners can share one database and the host's Docker, for more reviews at once:

```bash
docker compose up -d --scale runner=2
```

- **Jobs and reviews.** Runners take jobs, comment jobs and executions with `FOR UPDATE SKIP
LOCKED`, so each goes to one runner, and a PR's jobs are still handled one at a time, in order.
  `LGTMOOSE_MAX_EXECUTIONS` is per runner.
- **Heartbeats.** Each runner process registers in `local_runners` and beats every 10 seconds.
  Its executions record its ID, and its sandboxes carry its ID in the `lgtmoose.runner` label.
- **A runner that stops.** At start and every minute, each runner fails the executions of
  runners whose heartbeat is older than `LGTMOOSE_RUNNER_STALE_SECONDS` (120 by default), as a
  lost Fargate task fails its step on AWS, and removes their sandboxes. A live runner's
  executions and sandboxes are never touched. Keep the threshold well above the heartbeat: a
  runner that can't reach the database for longer than it counts as stopped.
- **Schedules.** The reconciler, the credential check and the retention sweep each run behind a
  Postgres advisory lock, on one runner at a time, and only when they haven't run for half
  their interval, so they run about once per interval between all the runners.

## The Docker socket

**The runner holds the Docker socket, and the Docker socket is root on the host.** Whatever can
talk to it can start a container with the host's filesystem mounted and do anything. That's
the price of starting a sandbox per batch on one host. The design keeps it to one process:

- Only `runner` mounts the socket. The gateway, which faces the internet, doesn't. Neither do
  the sandboxes, which run model output.
- The runner makes exactly the calls in `apps/control/src/local/docker.ts`, and every sandbox
  it creates is: read-only root filesystem, all capabilities dropped, no new privileges, a pid
  limit, memory and CPU caps, its image's unprivileged user, and only the internal sandbox
  network (the runner refuses to start if that network isn't internal). No host path, no
  socket, no GitHub token, only its own provider's credential.
- A sandbox gets only its batch: the runner copies that batch's input and checkout into the
  container's own volume before it starts, and copies back only the files it may write (its
  output, transcripts and a refreshed sign-in), never more than 64 MB and never a symlink.
- Even so, a bug in the runner, or someone who gets code into the runner, has the host. Run
  this on a host or VM that does nothing else, keep the runner's image what you built from this
  repository, and keep the socket's group to the runner.

If you can't accept that, use the AWS deployment, where sandboxes are Fargate tasks and no
process holds a Docker socket, or run Docker rootless, so the socket is your user, not root.

## Credentials

A provider credential is in the sandbox's environment while it runs, and anyone who can use the
Docker socket can read it with `docker inspect`, as they can read the secrets directory. The
credential broker works as on AWS: each provider's credential is leased per sandbox, up to its
`concurrency` (always 1 for a ChatGPT sign-in), and a refreshed `auth.json` is written back
only by the lease holder, for the same account, into `secrets/`.

## Upgrading and stopping

Pull or check out the new version, then rebuild and restart:

```bash
docker compose --profile build build
```

```bash
docker compose up -d
```

The runner applies new migrations at start. Reviews running when a runner stops are failed by
another runner, or by the next start, once its heartbeat is stale, and redone on the next push
or reconcile.

```bash
docker compose down
```

stops everything and keeps the database volume; `docker compose down -v` deletes it too.

## Not built yet

- Release images (`images.source: release`) apply to AWS only; compose builds from the checkout.
- Bedrock and Vertex providers, and Bedrock embeddings.
