import { join } from "node:path";

type Source = Readonly<Record<string, string | undefined>>;

/** Network settings the sandbox may need to reach the model API through its egress proxy. */
export const NETWORK_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

/** The set `NETWORK_VARS` from the source, for a CLI's environment. */
export function networkEnv(source: Source): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of NETWORK_VARS) {
    const value = source[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

/**
 * Variables every harness sets so the CLI and git read nothing but the checkout: a fresh home
 * and temp dir, and git without user or system config, pager, prompts or lazy fetches. Each
 * adapter adds its CLI's own.
 */
export function isolatedEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: join(home, "tmp"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}
