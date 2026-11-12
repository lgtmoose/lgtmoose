import type { JobQueue, SecretStore } from "../ports.js";

/** The webhook secret from an environment variable, for server.ts and docker compose. */
export function envSecretStore(
  name = "GITHUB_WEBHOOK_SECRET",
  env: NodeJS.ProcessEnv = process.env,
): SecretStore {
  return {
    // Read on every call: there's no network round trip to save, and tests can change it.
    async get() {
      const value = env[name];
      if (value === undefined || value === "") throw new Error(`${name} is not set`);
      return value;
    },
  };
}

/**
 * Logs jobs instead of queueing them. Stands in for the pg-boss queue (NIC-843) so the local
 * server can be pointed at real GitHub deliveries before a worker exists.
 */
export function logJobQueue(log: (line: string) => void = console.log): JobQueue {
  return {
    async send(job, { groupId, dedupeId }) {
      log(JSON.stringify({ msg: "job not queued (log-only queue)", groupId, dedupeId, job }));
    },
  };
}
