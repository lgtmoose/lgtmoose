import { createApp } from "./app.js";

/** Runs the gateway as a plain Node server, for local development and docker compose. */
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`PORT must be a whole number from 1 to 65535, got "${process.env.PORT}".`);
  process.exit(1);
}

/** docker compose waits 10s after SIGTERM before SIGKILL; finish in-flight requests before that. */
const SHUTDOWN_GRACE_MS = 8_000;

const app = createApp({ version: process.env.LGTMOOSE_VERSION ?? "dev" });
const server = app.listen(port, () => {
  console.log(`LGTMoose gateway listening on http://localhost:${port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, finishing in-flight requests`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
