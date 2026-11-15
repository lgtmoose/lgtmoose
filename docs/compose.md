# docker compose

LGTMoose on one host, without AWS: a gateway, a runner, an egress proxy and Postgres, in
[deploy/compose/compose.yaml](../deploy/compose/compose.yaml). Reviews behave as on AWS. The
same code runs, with Postgres in place of SQS, S3 and Step Functions, and one Docker container
per batch in place of a Fargate task.

Read [The Docker socket](#the-docker-socket) before you run it.

## What runs

| Service        | Does                                                                                                       | Reaches                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `gateway`      | Verifies GitHub's webhooks and queues jobs                                                                 | The internet (inbound, on `GATEWAY_PORT`), Postgres as a login that may only add jobs |
| `runner`       | The dispatcher, the review workflow, prepare and post, `@lgtmoose` commands and replies, and the schedules | Postgres, GitHub, the secrets directory, the Docker socket                            |
| `egress-proxy` | Lets sandboxes reach the model APIs in `LGTMOOSE_EGRESS_HOSTS`, and nothing else                           | The internet (outbound), the sandbox network                                          |
| sandboxes      | One per batch, started and removed by the runner: run the reviewer on that batch                           | The sandbox network only: the egress proxy is their one way out                       |
| `postgres`     | Jobs, runs, findings, learnings, artifacts                                                                 | The internal database network only                                                    |

On a schedule, the runner also:

- runs the reconciler every `reconcileIntervalMinutes`, with retiring unused learnings and reading feedback;
- checks the stored credentials every 6 hours;
- once a day, deletes artifacts and ended runs older than 30 days, as the S3 lifecycle rule does on AWS.

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

The runner applies new migrations at start. Reviews running when it stops are failed on the
next start and redone on the next push or reconcile.

```bash
docker compose down
```

stops everything and keeps the database volume; `docker compose down -v` deletes it too.

## Not built yet

- The dashboard (an AWS stack) has no compose service.
- Release images (`images.source: release`) apply to AWS only; compose builds from the checkout.
- Bedrock and Vertex providers, and Bedrock embeddings.
