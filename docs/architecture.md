# Architecture

## Core rule

The model only reads repo files and returns findings as JSON. Plain code does everything else: holding the GitHub token, posting, labels, the review decision, memory writes and bookkeeping. The sandbox that runs the model holds one short-lived model credential and can reach only that vendor's API.

## Components

| Component         | Runs on                               | Holds GitHub credentials | Job                                                                      |
| ----------------- | ------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| Gateway           | Lambda behind API Gateway             | Webhook secret only      | Verify HMAC, dedupe deliveries, enqueue                                  |
| Queue             | SQS FIFO, group = `owner/repo#pr`     | No                       | Order jobs per PR                                                        |
| Dispatcher        | Lambda                                | No                       | Start a Step Functions run, supersede older runs                         |
| Review workflow   | Step Functions                        | No                       | prepare → map batches → cross-file → map verify → post                   |
| Control tasks     | Fargate                               | Yes                      | Clone and plan; dedupe, decide and post                                  |
| Sandbox tasks     | Fargate, private subnet, egress proxy | **No**                   | Run the harness (`claude -p`, `codex exec`, `cursor agent`) on one batch |
| Credential broker | Control plane + Secrets Manager       | No                       | Hand each sandbox task one model credential; write back refreshed tokens |
| Reconciler        | Scheduled Lambda                      | Yes (read)               | Re-queue anything missed. No model calls.                                |
| State             | RDS Postgres + pgvector, S3           | n/a                      | Runs, findings, learnings, usage, transcripts                            |

## Harnesses

Each vendor's official CLI runs headless behind a small adapter, restricted to read-only tools and validated with zod:

- `claude-code`: OAuth token from `claude setup-token`, `ANTHROPIC_API_KEY`, or Bedrock/Vertex
- `codex`: ChatGPT sign-in (`auth.json`), Codex access token, or `OPENAI_API_KEY`
- `cursor-agent`: user or service-account API key
- `agent-sdk`: Claude Agent SDK in-process, for API-key and Bedrock users

Check each vendor's current terms before using plan credentials. `lgtmoose setup` defaults to Bedrock or an API key.

One AWS account and region holds one install. `lgtmoose setup` writes fixed Secrets Manager names (`lgtmoose/github-app`, `lgtmoose/github-webhook-secret`), so a second install there would overwrite the first one's App credentials. Use another account or region for staging until deployment names land.

## Security controls

- The model can't approve. The decision is a pure function of verified findings.
- Learnings are written only through a policy check (author permission and provenance). The model can only propose them.
- Protected categories (`authz`, `tenant_scoping`, `money`, `secrets`) can't be suppressed by learnings or dedupe.
- PR code is never executed.
