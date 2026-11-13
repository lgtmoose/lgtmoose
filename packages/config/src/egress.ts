import type { DeployConfig, ProviderConfig } from "./deploy.js";

/**
 * The hosts a provider's CLI talks to, by harness and auth method. Sandbox tasks reach the
 * internet only through the egress proxy, which allows exactly these hosts (plus the config's
 * `extraEgressHosts`), on port 443. Exact names only: the proxy has no wildcards.
 *
 * `{region}` is the deploy region. Vertex AI picks its own region (CLOUD_ML_REGION): the global
 * endpoint is listed, and a regional one (`us-east5-aiplatform.googleapis.com`) goes in
 * `extraEgressHosts`.
 */
const PROVIDER_HOSTS: Record<
  ProviderConfig["harness"],
  Partial<Record<ProviderConfig["auth"], readonly string[]>>
> = {
  "claude-code": {
    "oauth-token": ["api.anthropic.com"],
    "api-key": ["api.anthropic.com"],
    bedrock: ["bedrock-runtime.{region}.amazonaws.com"],
    vertex: ["aiplatform.googleapis.com", "oauth2.googleapis.com"],
  },
  "agent-sdk": {
    "api-key": ["api.anthropic.com"],
    bedrock: ["bedrock-runtime.{region}.amazonaws.com"],
    vertex: ["aiplatform.googleapis.com", "oauth2.googleapis.com"],
  },
  // Codex signed in with ChatGPT uses the ChatGPT backend and refreshes its token with OpenAI's
  // auth service; with an API key it uses the platform API.
  codex: {
    "chatgpt-login": ["chatgpt.com", "auth.openai.com"],
    "access-token": ["chatgpt.com", "auth.openai.com"],
    "api-key": ["api.openai.com"],
  },
  // Not yet checked against the cursor-agent CLI (NIC-822): confirm when that adapter lands.
  "cursor-agent": {
    "api-key": ["api2.cursor.sh"],
    "service-account": ["api2.cursor.sh"],
  },
};

/** The hosts one provider needs, with the region filled in. */
export function providerEgressHosts(provider: ProviderConfig, region: string): string[] {
  const hosts = PROVIDER_HOSTS[provider.harness][provider.auth] ?? [];
  return hosts.map((host) => host.replace("{region}", region));
}

/**
 * Every host sandbox tasks may reach through the egress proxy: the model APIs of the enabled
 * providers and the config's `extraEgressHosts`, deduplicated and sorted. GitHub and everything
 * else is refused.
 */
export function egressAllowlist(
  config: Pick<DeployConfig, "providers" | "region" | "extraEgressHosts">,
): string[] {
  const hosts = new Set<string>();
  for (const provider of config.providers) {
    for (const host of providerEgressHosts(provider, config.region)) hosts.add(host);
  }
  for (const host of config.extraEgressHosts) hosts.add(host);
  return [...hosts].sort();
}
