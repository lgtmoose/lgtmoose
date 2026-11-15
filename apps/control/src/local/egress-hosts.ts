import { egressAllowlist } from "@lgtmoose/config";
import { readLocalSettings } from "./settings.js";

/**
 * Prints the hosts the egress proxy must allow for this config, comma-separated, for
 * `LGTMOOSE_EGRESS_HOSTS` in the compose `.env`:
 *
 *   docker compose run --rm --no-deps --entrypoint node runner /app/dist/local/egress-hosts.js
 *
 * The runner checks the `.env` list against the config on every start (`checkEgressHosts`).
 */
async function main(): Promise<void> {
  const settings = await readLocalSettings(
    process.env.LGTMOOSE_CONFIG?.trim() || "/config/lgtmoose.config.json",
  );
  process.stdout.write(`${egressAllowlist(settings.config).join(",")}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
