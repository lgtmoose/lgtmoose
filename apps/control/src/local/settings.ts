import { readFile } from "node:fs/promises";
import {
  credentialConcurrency,
  egressAllowlist,
  modelFor,
  parseDeployConfig,
  providerChain,
  providerNeedsSecret,
  SECRET_NAMES,
  type DeployConfig,
} from "@lgtmoose/config";
import {
  readEmbeddingsSettings,
  readTicketSettings,
  type EmbeddingsSettings,
  type TicketSettings,
} from "../env.js";
import type { SandboxProvider } from "./sandbox.js";

/**
 * The docker compose runner's settings, from the same deploy config the CDK app reads (as JSON:
 * `lgtmoose.config.json`), worked out as the CDK app works them out for the AWS tasks. One
 * config describes both deployments; what only AWS uses (region, profile, alarms, images,
 * dashboard) is ignored here.
 */
export interface LocalSettings {
  config: DeployConfig;
  /** The reviewer's provider first, then the others in config order (`providerChain`). */
  providers: SandboxProvider[];
  reviewerModel: string;
  embeddings: EmbeddingsSettings;
  tickets: TicketSettings;
}

/** Providers a single host can't run: AWS Bedrock and Google Vertex need cloud credentials. */
const CLOUD_AUTH = new Set(["bedrock", "vertex"]);

/** The settings from a parsed config. Throws when a provider can't run on a single host. */
export function localSettings(config: DeployConfig): LocalSettings {
  const cloud = config.providers.filter((provider) => CLOUD_AUTH.has(provider.auth));
  if (cloud.length > 0) {
    throw new Error(
      `The docker compose deployment can't use ${cloud.map((p) => `${p.id} (${p.auth})`).join(", ")}: use an API key or plan token, or deploy to AWS.`,
    );
  }
  if (config.learnings.embeddings.provider === "bedrock") {
    throw new Error("learnings.embeddings: bedrock needs AWS. Use openai or none.");
  }
  const chain = providerChain(config, "reviewer");
  const providers = chain.map((provider): SandboxProvider => ({
    id: provider.id,
    harness: provider.harness,
    auth: provider.auth,
    model: modelFor(provider, "standard") ?? "default",
    fastModel: modelFor(provider, "fast") ?? "default",
    ...(provider.thinkingTokens?.standard === undefined
      ? {}
      : { thinkingTokens: provider.thinkingTokens.standard }),
    ...(provider.thinkingTokens?.fast === undefined
      ? {}
      : { fastThinkingTokens: provider.thinkingTokens.fast }),
    ...(providerNeedsSecret(provider)
      ? {
          credential: {
            secretId: SECRET_NAMES.provider(provider.id),
            limit: credentialConcurrency(provider),
          },
        }
      : {}),
  }));
  const reviewer = chain[0];
  // The same values the Workflow stack sets on the control task (embeddingsEnvironment and
  // ticketsEnvironment in infra/cdk/lib/workflow-stack.ts), read the same way.
  const embeddings = config.learnings.embeddings;
  const tickets = config.tickets;
  return {
    config,
    providers,
    reviewerModel: reviewer === undefined ? "" : (modelFor(reviewer, "standard") ?? ""),
    embeddings: readEmbeddingsSettings(
      embeddings.provider === "openai"
        ? {
            LGTMOOSE_EMBEDDINGS: `openai:${embeddings.model}`,
            LGTMOOSE_EMBEDDINGS_SECRET_ID: SECRET_NAMES.openAiEmbeddings,
          }
        : { LGTMOOSE_EMBEDDINGS: "none" },
    ),
    tickets: readTicketSettings(
      tickets === undefined
        ? { LGTMOOSE_TICKETS: "none" }
        : {
            LGTMOOSE_TICKETS: tickets.provider,
            LGTMOOSE_TICKETS_SECRET_ID: SECRET_NAMES.linearTickets,
            LGTMOOSE_TICKETS_MAX: String(tickets.maxPerPullRequest),
            LGTMOOSE_TICKETS_TEAMS: tickets.teamKeys.map((team) => team.toUpperCase()).join(","),
            LGTMOOSE_TICKETS_PUBLIC_DETAILS: String(tickets.detailsOnPublicRepos),
          },
    ),
  };
}

/**
 * Checks the egress proxy's allowlist (`LGTMOOSE_EGRESS_HOSTS`, which compose gives both the
 * proxy and the runner) against what the config needs. Throws when they differ, so a provider
 * added to the config without the proxy being told can't silently fail every review, and the
 * proxy can't quietly allow a host nothing needs.
 */
export function checkEgressHosts(config: DeployConfig, configured: string | undefined): void {
  const want = egressAllowlist(config);
  const have = [
    ...new Set(
      (configured ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host !== ""),
    ),
  ].sort();
  if (want.join(",") !== have.join(",")) {
    throw new Error(`LGTMOOSE_EGRESS_HOSTS doesn't match the config. Set it to: ${want.join(",")}`);
  }
}

/** Reads and validates `lgtmoose.config.json`. */
export async function readLocalSettings(path: string): Promise<LocalSettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Couldn't read the config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // `$schema` points editors at the JSON Schema; it isn't config.
  if (typeof raw === "object" && raw !== null && "$schema" in raw) {
    const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    delete rest.$schema;
    raw = rest;
  }
  return localSettings(parseDeployConfig(raw, path));
}
