import type { DeployConfig, ProviderConfig } from "./deploy.js";
import { vertexHost } from "./models.js";

/**
 * The hosts a provider's CLI talks to, by harness and auth method. Sandbox tasks reach the
 * internet only through the egress proxy, which allows exactly these hosts (plus the config's
 * `extraEgressHosts`), on port 443. Exact names only: the proxy has no wildcards.
 *
 * `{region}` is the deploy region. `{vertex}` is the Vertex AI host for the provider's
 * `vertex.region` (`vertexHost`). Bedrock also needs its control-plane host: Claude Code lists the
 * account's inference profiles there to resolve model IDs
 * (https://code.claude.com/docs/en/amazon-bedrock#cross-region-inference-profile-prefixes).
 */
const PROVIDER_HOSTS: Record<
  ProviderConfig["harness"],
  Partial<Record<ProviderConfig["auth"], readonly string[]>>
> = {
  "claude-code": {
    "oauth-token": ["api.anthropic.com"],
    "api-key": ["api.anthropic.com"],
    bedrock: ["bedrock-runtime.{region}.amazonaws.com", "bedrock.{region}.amazonaws.com"],
    vertex: ["{vertex}", "oauth2.googleapis.com"],
  },
  "agent-sdk": {
    "api-key": ["api.anthropic.com"],
    bedrock: ["bedrock-runtime.{region}.amazonaws.com", "bedrock.{region}.amazonaws.com"],
    vertex: ["{vertex}", "oauth2.googleapis.com"],
  },
  // Codex signed in with ChatGPT uses the ChatGPT backend and refreshes its token with OpenAI's
  // auth service; with an API key it uses the platform API. Check these against the pinned Codex
  // CLI with its adapter (NIC-821).
  codex: {
    "chatgpt-login": ["chatgpt.com", "auth.openai.com"],
    "access-token": ["chatgpt.com", "auth.openai.com"],
    "api-key": ["api.openai.com"],
  },
  // Cursor's network configuration docs (https://cursor.com/docs/enterprise/network-configuration)
  // name api2.cursor.sh for most API traffic and api5.cursor.sh for agent requests. Its Tab
  // (api3, api4, gcpp) and codebase-search (repo42) hosts aren't used by a headless review.
  // Not yet seen in real cursor-agent traffic: confirm with the AWS smoke test (NIC-853).
  "cursor-agent": {
    "api-key": ["api2.cursor.sh", "api5.cursor.sh"],
    "service-account": ["api2.cursor.sh", "api5.cursor.sh"],
  },
};

/** The hosts one provider needs, with the region filled in. */
export function providerEgressHosts(provider: ProviderConfig, region: string): string[] {
  const hosts = PROVIDER_HOSTS[provider.harness][provider.auth] ?? [];
  const vertex = vertexHost(provider.vertex?.region ?? "global");
  return hosts.map((host) => host.replace("{region}", region).replace("{vertex}", vertex));
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
