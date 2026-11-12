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
  // Exactly one proxy sits in front (API Gateway, or the reverse proxy in docker compose). Trusting
  // more hops would let callers choose req.ip with their own X-Forwarded-For header.
  app.set("trust proxy", 1);
  app.use(helmet());

  app.use("/webhooks", webhooksRouter());

  app.use(express.json({ limit: MAX_JSON_BYTES }));
  app.use(ROUTES.health, healthRouter(env.version));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
