import express, { type Express } from "express";
import helmet from "helmet";
import { errorHandler, notFound } from "./middleware/errors.js";
import { MAX_JSON_BYTES, ROUTES } from "./paths.js";
import { healthRouter } from "./routes/health.js";
import { webhooksRouter } from "./routes/webhooks.js";

export { ROUTES } from "./paths.js";

export interface GatewayEnv {
  /** Deployed LGTMoose version, reported by the health route. */
  version: string;
  /** Largest webhook body accepted. Defaults to GitHub's 25 MB cap. */
  maxWebhookBytes?: string | number;
}

/**
 * Builds the gateway's Express app. The same app runs on Lambda (lambda.ts) and as a plain Node
 * server (server.ts) for local development and the docker compose deployment.
 *
 * Order matters: the webhook router is mounted before the JSON parser, so webhook bodies reach
 * signature verification as the exact bytes GitHub sent.
 */
export function createApp(env: GatewayEnv): Express {
  const app = express();
  app.disable("x-powered-by");
  // API Gateway (or a reverse proxy in docker compose) sits in front; trust its X-Forwarded-*.
  app.set("trust proxy", true);
  app.use(helmet());

  app.use("/webhooks", webhooksRouter(env.maxWebhookBytes));

  app.use(express.json({ limit: MAX_JSON_BYTES }));
  app.use(ROUTES.health, healthRouter(env.version));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
