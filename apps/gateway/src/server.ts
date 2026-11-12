import { envWebhookSecret, logJobQueue } from "./adapters/local.js";
import { createApp } from "./app.js";
import { parseAllowedOrgs, requiredEnv } from "./env.js";

/**
 * Runs the gateway as a plain Node server, for local development and docker compose.
 *
 * PORT: where to listen (default 3000).
 * TRUST_PROXY_HOPS: proxies in front that append to X-Forwarded-For (default 0, i.e. callers
 * connect directly). Set it to 1 when a reverse proxy sits in front.
 * GITHUB_WEBHOOK_SECRET: the App's webhook secret (required).
 * ALLOWED_ORGS: comma-separated GitHub orgs or users whose repositories may be reviewed
 * (required).
 *
 * Jobs are only logged until the pg-boss queue lands (NIC-843).
 */
function wholeNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`${name} must be a whole number from ${min} to ${max}, got "${raw}".`);
    process.exit(1);
  }
  return value;
}

/** Runs a required-setting check once at startup, so a misconfigured server never listens. */
function startupValue<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    console.error(`LGTMoose gateway couldn't start: ${(error as Error).message}`);
    process.exit(1);
  }
}

const port = wholeNumberEnv("PORT", 3000, 1, 65_535);
const trustProxyHops = wholeNumberEnv("TRUST_PROXY_HOPS", 0, 0, 10);
startupValue(() => requiredEnv("GITHUB_WEBHOOK_SECRET"));
const allowedOrgs = startupValue(() => parseAllowedOrgs(process.env.ALLOWED_ORGS));

/** docker compose waits 10s after SIGTERM before SIGKILL; finish in-flight requests before that. */
const SHUTDOWN_GRACE_MS = 8_000;

const app = createApp(
  { version: process.env.LGTMOOSE_VERSION ?? "dev", trustProxyHops },
  { secrets: envWebhookSecret("GITHUB_WEBHOOK_SECRET"), queue: logJobQueue(), allowedOrgs },
);
// Express 5 calls this on failure too, with the error, so it reports success only when listening.
const server = app.listen(port, (error?: NodeJS.ErrnoException) => {
  if (error) {
    const reason = error.code === "EADDRINUSE" ? `port ${port} is already in use` : error.message;
    console.error(`LGTMoose gateway couldn't start: ${reason}`);
    process.exit(1);
  }
  console.log(`LGTMoose gateway listening on http://localhost:${port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, finishing in-flight requests`);
  server.close((error) => {
    if (error) console.error(`Shutdown failed: ${error.message}`);
    process.exit(error ? 1 : 0);
  });
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
