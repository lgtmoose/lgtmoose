# docker compose deployment

For hosts other than AWS (NIC-843). It's built in two parts, and **it can't be run yet**: there's no `compose.yaml` until part 2.

## Part 1: the core (built)

What the AWS deployment keeps in SQS, S3 and Step Functions is kept in Postgres, with the same guarantees the code relies on. On AWS none of it is used.

| On AWS                                         | On a single host                                   | Where                        |
| ---------------------------------------------- | -------------------------------------------------- | ---------------------------- |
| SQS FIFO job queue                             | `job_queue` table (`PostgresQueue`)                | `packages/db/src/local.ts`   |
| S3 artifact bucket, with conditional writes    | `artifacts` table (`postgresArtifactStore`)        | `packages/db/src/local.ts`   |
| Step Functions executions                      | `local_executions` table (`postgresExecutions`)    | `packages/db/src/local.ts`   |
| Dispatcher Lambda and the review state machine | the runner (`createRunner`, `runExecution`)        | `apps/control/src/local/`    |
| Gateway Lambda                                 | the gateway's Node server, with `DATABASE_URL` set | `apps/gateway/src/server.ts` |

The runner calls the same `dispatchBatch`, `prepare`, `post` and `fail` the Lambdas and the control task run. Only the orchestration around them is new.

- **Job queue:** in order per PR, at least once, and deduplicated by delivery ID.
  - A message is handed out only when no older message of its PR is waiting or in flight.
  - One that isn't acknowledged in time is handed out again.
  - One that fails 5 times, or isn't a job, goes to the `dead` queue.
- **Artifact store:** `createText`, `replaceText` and `deleteIfMatch` are single SQL statements on the object's row. So the post step's review claim and the credential leases hold however many processes write at once.
- **Runner:** debounce, prepare, each batch (up to the map state's concurrency), then post. Prepare and post are retried, and a run that still fails is failed, never half-posted. A batch that fails is a failed batch for the post step, so the review is incomplete and can't approve. Executions a previous runner process left running are failed at start.

Tests: `packages/db/src/local.test.ts` (PGlite), `packages/db/src/local.integration.test.ts` (real Postgres, concurrent connections, in CI), and `apps/control/src/local/runner.test.ts`. That last one takes a delivered job through the queue, the dispatcher, prepare, a batch and post, against a real git remote, with a stand-in for the sandbox.

## Part 2: running it (next)

- The runner's entrypoint, with the GitHub App's credentials from the environment.
- The sandbox as a `docker run` per batch: read-only root filesystem, no GitHub token, only its provider's credential, and a network that reaches only the egress proxy.
- An artifact endpoint the sandboxes read their batch from, in place of presigned S3 URLs.
- The reconciler, the credential health check and the conversation handler on a schedule.
- `compose.yaml`, `.env.example`, a database role for the gateway that may only add jobs, and `docs/compose.md`.
