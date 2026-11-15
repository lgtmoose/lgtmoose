# docker compose deployment

LGTMoose on one host, without AWS (NIC-843). How to set it up, and what holding the Docker socket
means, is in [docs/compose.md](../../docs/compose.md).

- `compose.yaml`: the gateway, the runner, the egress proxy and Postgres, and the sandbox image.
- `.env.example`: the settings, all placeholders. Copy it to `.env`.
- `lgtmoose.config.example.json`: a minimal config. Copy it to `lgtmoose.config.json`.
- `secrets/`: one file per secret, which you create. Never committed.

| On AWS                                         | On a single host                                          | Where                                                           |
| ---------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| SQS FIFO job queue                             | `job_queue` table (`PostgresQueue`)                       | `packages/db/src/local.ts`                                      |
| S3 artifact bucket, with conditional writes    | `artifacts` table (`postgresArtifactStore`)               | `packages/db/src/local.ts`                                      |
| Step Functions executions                      | `local_executions` table (`postgresExecutions`)           | `packages/db/src/local.ts`                                      |
| Dispatcher Lambda and the review state machine | the runner (`createRunner`, `runExecution`)               | `apps/control/src/local/`                                       |
| Sandbox Fargate tasks, leases and fallback     | one container per batch (`dockerBatchRunner`)             | `apps/control/src/local/sandbox.ts`                             |
| Conversation, reconciler and health Lambdas    | the runner's schedules                                    | `apps/control/src/local/main.ts`                                |
| Secrets Manager                                | files in `secrets/`                                       | `apps/control/src/local/secrets.ts`                             |
| S3 lifecycle rule                              | the runner's daily sweep                                  | `apps/control/src/local/services.ts`                            |
| Gateway Lambda                                 | the gateway's Node server, as a login that adds jobs only | `apps/gateway/src/server.ts`, `packages/db/src/gateway-role.ts` |
