/**
 * What the sandbox task reads from its environment, set by the Workflow stack. Its batch input
 * and output come as presigned URLs from the workflow (NIC-811), added when that lands: the task
 * role has no S3 access of its own.
 */
export interface SandboxEnv {
  /** The model provider this task definition was built for. */
  providerId: string;
  /** Where HTTPS to model APIs goes: the egress proxy. */
  httpsProxy: string;
}

const VARIABLES = {
  providerId: "LGTMOOSE_PROVIDER",
  httpsProxy: "HTTPS_PROXY",
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
  };
}
