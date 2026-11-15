---
"lgtmoose": minor
---

docker compose: the dashboard as a `dashboard` service (its own database login, the OAuth client and a generated signing key, the same headers and checks as on AWS), and more than one runner (`--scale runner=N`): runners beat in `local_runners`, fail and clean up only after runners whose heartbeat is stale, and run the scheduled jobs behind Postgres advisory locks.
