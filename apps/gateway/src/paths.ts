/**
 * Paths the Api stack routes to the gateway. The CDK app imports this file (and only this file,
 * so synth doesn't load Express), which keeps the stack's routes and the app's routes in step.
 */
export const ROUTES = {
  health: "/health",
  githubWebhook: "/webhooks/github",
} as const;

/** GitHub caps webhook payloads at 25 MB; anything larger isn't from GitHub. */
export const MAX_WEBHOOK_BYTES = "25mb";

/** Limit for JSON bodies on the REST API. */
export const MAX_JSON_BYTES = "1mb";
