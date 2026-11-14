/**
 * What the sandbox task reads from its environment. The Workflow stack sets the provider and the
 * proxy on the task definition; the review state machine adds `LGTMOOSE_BATCH_URLS` per task.
 * The task role has no S3 access: that one presigned URL leads to the batch's others.
 */
export interface SandboxEnv {
  /** The model provider this task definition was built for. */
  providerId: string;
  /** Where HTTPS to model APIs goes: the egress proxy. */
  httpsProxy: string;
  /** The provider's harness, such as `claude-code`. */
  harness: string;
  /** The provider's auth method, such as `oauth-token`. */
  auth: string;
  /** A presigned GET for the batch's `urls.json`. */
  batchUrls: string;
}

const VARIABLES = {
  providerId: "LGTMOOSE_PROVIDER",
  httpsProxy: "HTTPS_PROXY",
  harness: "LGTMOOSE_HARNESS",
  auth: "LGTMOOSE_AUTH",
  batchUrls: "LGTMOOSE_BATCH_URLS",
} as const satisfies Record<keyof SandboxEnv, string>;

/** Reads the sandbox task's settings, or says which variables are missing (blank counts). */
export function readSandboxEnv(
  env: Readonly<Record<string, string | undefined>>,
): SandboxEnv | { missing: string[] } {
  const missing = Object.values(VARIABLES).filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { missing };
  const read = (name: string) => env[name]?.trim() ?? "";
  return {
    providerId: read(VARIABLES.providerId),
    httpsProxy: read(VARIABLES.httpsProxy),
    harness: read(VARIABLES.harness),
    auth: read(VARIABLES.auth),
    batchUrls: read(VARIABLES.batchUrls),
  };
}
