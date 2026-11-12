import { Hono } from "hono";

/** Paths the Api stack routes to the gateway. Kept here so the stack and the app can't drift. */
export const ROUTES = {
  health: "/health",
  githubWebhook: "/webhooks/github",
} as const;

export interface GatewayEnv {
  /** Deployed LGTMoose version, reported by the health route. */
  version: string;
}

/**
 * The gateway's HTTP app. The webhook route answers 501 until NIC-804 adds signature checks,
 * delivery dedupe and queueing; GitHub then marks deliveries as failed, which is harmless in
 * shadow mode.
 */
export function createApp(env: GatewayEnv): Hono {
  const app = new Hono();

  app.get(ROUTES.health, (c) => c.json({ ok: true, version: env.version }));

  app.post(ROUTES.githubWebhook, (c) =>
    c.json({ error: "Webhook handling isn't built yet (NIC-804)." }, 501),
  );

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return app;
}
