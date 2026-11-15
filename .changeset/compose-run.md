---
"lgtmoose": minor
---

docker compose, part 2: run LGTMoose on one host. `deploy/compose/compose.yaml` starts the gateway, a runner, the egress proxy and Postgres. The runner starts one locked-down sandbox container per batch, with credential leases and provider fallback, and runs the reconciler, credential checks, `@lgtmoose` commands and replies, and a retention sweep. See docs/compose.md.
