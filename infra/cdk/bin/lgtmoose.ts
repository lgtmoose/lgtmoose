import { buildApp } from "../lib/app.js";
import { loadConfig } from "../lib/load-config.js";

const { config, path } = await loadConfig();
if (path === undefined) {
  console.warn(
    "No lgtmoose.config.ts found, using the example config. Run `lgtmoose setup` first.",
  );
}
buildApp(config).app.synth();
