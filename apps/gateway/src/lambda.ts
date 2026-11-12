import { configure } from "@codegenie/serverless-express";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createApp } from "./app.js";

/**
 * Lambda entry point behind the API Gateway HTTP API (payload format 2.0). The only
 * Lambda-specific code: everything else is a normal Express app.
 */
export const handler: APIGatewayProxyHandlerV2 = configure({
  // API Gateway is the one proxy in front of the Lambda.
  app: createApp({ version: process.env.LGTMOOSE_VERSION ?? "unknown", trustProxyHops: 1 }),
});
