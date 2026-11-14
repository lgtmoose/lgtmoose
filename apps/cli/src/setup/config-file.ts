import { parseDeployConfig, type DeployConfigInput } from "@lgtmoose/config";
import { CLI } from "../paths.js";

export type Profile = "lean" | "standard";

export interface ConfigSettings {
  region: string;
  profile: Profile;
  owner: string;
}

/** Bedrock needs no stored key, so a new install works before `lgtmoose auth` runs. */
export const DEFAULT_PROVIDER = { id: "claude", harness: "claude-code", auth: "bedrock" } as const;

export function configFor(settings: ConfigSettings): DeployConfigInput {
  return {
    region: settings.region,
    profile: settings.profile,
    allowedOrgs: [settings.owner],
    providers: [{ ...DEFAULT_PROVIDER }],
  };
}

/**
 * The text of lgtmoose.config.ts. It's validated before it's rendered, so setup never writes
 * a file that `lgtmoose deploy` would reject. Values are JSON-encoded, which is valid TS.
 */
export function renderConfigFile(settings: ConfigSettings): string {
  const config = configFor(settings);
  parseDeployConfig(config);
  return `// Written by \`${CLI} setup\`. Edit freely: \`${CLI} deploy\` validates it.
import { defineConfig } from "@lgtmoose/config";

export default defineConfig({
  region: ${JSON.stringify(config.region)},
  profile: ${JSON.stringify(config.profile)},
  // GitHub orgs or users whose repos may be reviewed.
  allowedOrgs: ${JSON.stringify(config.allowedOrgs)},
  // Add more with \`${CLI} auth\`. Bedrock uses the deployment's IAM role.
  providers: [${config.providers.map(renderObject).join(", ")}],
});
`;
}

/** `{ id: "claude", auth: "bedrock" }`, formatted the way Prettier would. */
function renderObject(object: object): string {
  const fields = Object.entries(object).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `{ ${fields.join(", ")} }`;
}
