/** Environment parsing shared by lambda.ts and server.ts. Both fail at startup, not per request. */

export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set`);
  return value;
}

/**
 * ALLOWED_ORGS is a comma-separated list of GitHub orgs or users, as the Api stack writes it.
 * An empty list would ignore every delivery without saying why, so it's an error instead.
 */
export function parseAllowedOrgs(raw: string | undefined): string[] {
  const orgs = (raw ?? "")
    .split(",")
    .map((org) => org.trim())
    .filter((org) => org.length > 0);
  if (orgs.length === 0) throw new Error("ALLOWED_ORGS must list at least one GitHub org or user");
  return orgs;
}
