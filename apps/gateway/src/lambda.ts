import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { configure } from "@codegenie/serverless-express";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { secretsManagerWebhookSecret, sqsJobQueue } from "./adapters/aws.js";
import { createApp } from "./app.js";
import { parseAllowedOrgs, requiredEnv } from "./env.js";

/**
 * Lambda entry point behind the API Gateway HTTP API (payload format 2.0). The only
 * Lambda-specific code: everything else is a normal Express app.
 *
 * Environment (set by the Api stack): JOB_QUEUE_URL, GITHUB_WEBHOOK_SECRET_ARN (the secret's
 * name; an ARN missing the random suffix does not resolve), ALLOWED_ORGS (comma-separated) and
 * LGTMOOSE_VERSION. A missing value fails the cold start, which shows up as failed deliveries
 * in GitHub rather than webhooks quietly ignored.
 */
const app = createApp(
  // API Gateway is the one proxy in front of the Lambda.
  { version: process.env.LGTMOOSE_VERSION ?? "unknown", trustProxyHops: 1 },
  {
    // Both SDK clients come from the Lambda runtime (they're external in the bundle) and pick up
    // the region and credentials from the function's environment.
    secrets: secretsManagerWebhookSecret({
      client: new SecretsManagerClient({}),
      secretId: requiredEnv("GITHUB_WEBHOOK_SECRET_ARN"),
    }),
    queue: sqsJobQueue({ client: new SQSClient({}), queueUrl: requiredEnv("JOB_QUEUE_URL") }),
    allowedOrgs: parseAllowedOrgs(process.env.ALLOWED_ORGS),
  },
);

export const handler: APIGatewayProxyHandlerV2 = configure({ app });
