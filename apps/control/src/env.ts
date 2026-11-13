/** What the control task reads from its environment, set by the Workflow stack. */
export interface ControlEnv {
  /** The artifact bucket: batch inputs, findings and transcripts. */
  artifactBucket: string;
  /** The database's generated secret: host, port, username and password. */
  databaseSecretArn: string;
  /** The database name, which the generated secret doesn't hold. */
  databaseName: string;
  /** The GitHub App secret (App ID, private key and the rest). */
  githubAppSecretArn: string;
}

const VARIABLES = {
  artifactBucket: "ARTIFACT_BUCKET",
  databaseSecretArn: "DATABASE_SECRET_ARN",
  databaseName: "DATABASE_NAME",
  githubAppSecretArn: "GITHUB_APP_SECRET_ARN",
} as const satisfies Record<keyof ControlEnv, string>;

/** Reads the control task's settings, or says which variables are missing (blank counts). */
export function readControlEnv(
  env: Readonly<Record<string, string | undefined>>,
): ControlEnv | { missing: string[] } {
  const missing = Object.values(VARIABLES).filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { missing };
  const read = (name: string) => env[name]?.trim() ?? "";
  return {
    artifactBucket: read(VARIABLES.artifactBucket),
    databaseSecretArn: read(VARIABLES.databaseSecretArn),
    databaseName: read(VARIABLES.databaseName),
    githubAppSecretArn: read(VARIABLES.githubAppSecretArn),
  };
}
