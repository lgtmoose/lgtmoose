/**
 * The variables a harness reads its credential from, for a provider's auth method. The task
 * definition hands every provider's stored credential to the task as
 * `LGTMOOSE_PROVIDER_CREDENTIAL`; this names it the way the CLI expects. Only these variables
 * reach the harness, never the rest of the task's environment.
 */
export function credentialEnv(
  harness: string,
  auth: string,
  credential: string | undefined,
): Record<string, string> {
  const need = (): string => {
    if (credential === undefined || credential.trim() === "") {
      throw new Error(`The ${harness} provider's ${auth} credential isn't set.`);
    }
    return credential.trim();
  };
  switch (`${harness}/${auth}`) {
    case "claude-code/oauth-token":
      return { CLAUDE_CODE_OAUTH_TOKEN: need() };
    case "claude-code/api-key":
      return { ANTHROPIC_API_KEY: need() };
    case "claude-code/bedrock":
      // The task role signs Bedrock calls; the harness passes the ECS credential variables on.
      return { CLAUDE_CODE_USE_BEDROCK: "1" };
    case "codex/chatgpt-login":
      return { CODEX_AUTH_JSON: need() };
    case "codex/access-token":
      return { CODEX_ACCESS_TOKEN: need() };
    case "codex/api-key":
      return { CODEX_API_KEY: need() };
    case "cursor-agent/api-key":
    case "cursor-agent/service-account":
      return { CURSOR_API_KEY: need() };
    default:
      throw new Error(`The sandbox can't run ${harness} with ${auth} auth yet.`);
  }
}

/** The task's variables a harness may see: no LGTMoose settings, no credential but its own. */
const PASSED = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

export function harnessEnv(
  task: Readonly<Record<string, string | undefined>>,
  credential: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = task[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...credential };
}
