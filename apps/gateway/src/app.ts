import express, { type Express } from "express";
import helmet from "helmet";
import { errorHandler, notFound } from "./middleware/errors.js";
import { MAX_JSON_BYTES, ROUTES } from "./paths.js";
import { healthRouter } from "./routes/health.js";
import { webhooksRouter, type WebhookDeps } from "./routes/webhooks.js";

export { ROUTES } from "./paths.js";
export type { JobQueue, WebhookSecretSource, SendOptions } from "./ports.js";
export type { WebhookDeps } from "./routes/webhooks.js";

export interface GatewayEnv {
  /** Deployed LGTMoose version, reported by the health route. */
  version: string;
  /**
   * How many proxies sit in front of the app and append to X-Forwarded-For. 1 behind API Gateway
   * or a reverse proxy; 0 when callers reach the server directly. Trusting more hops than really
   * exist lets callers choose req.ip with their own header.
   */
  trustProxyHops: number;
}

/**
 * Builds the gateway's Express app. The same app runs on Lambda (lambda.ts) and as a plain Node
 * server (server.ts) for local development and the docker compose deployment.
 *
 * Order matters: the webhook router is mounted before the JSON parser, so webhook bodies reach
 * signature verification as the exact bytes GitHub sent.
 *
 * `deps` holds everything host-specific (where the secret lives, where jobs go), so this file
 * never touches a cloud SDK: lambda.ts passes the AWS adapters, server.ts the local ones.
 */
export function createApp(env: GatewayEnv, deps: WebhookDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  if (!Number.isInteger(env.trustProxyHops) || env.trustProxyHops < 0) {
    throw new Error(`trustProxyHops must be a whole number 0 or more, got ${env.trustProxyHops}`);
  }
  app.set("trust proxy", env.trustProxyHops);
  app.use(helmet());

  app.use("/webhooks", webhooksRouter(deps));

  app.use(express.json({ limit: MAX_JSON_BYTES }));
  app.use(ROUTES.health, healthRouter(env.version));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
