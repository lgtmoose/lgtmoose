import {
  checkApiModel,
  checkBedrockModel,
  describeModelProblem,
  type BedrockModelApi,
  type ModelCheckResult,
  type ModelToCheck,
  type StatusGet,
} from "@lgtmoose/config";
import { z } from "zod";

/**
 * The model half of the scheduled health check (NIC-1121): every model a provider is pinned to
 * is asked for again, so one that stops being callable (model access revoked, a profile retired)
 * shows up as an alarm before a review hits it. `lgtmoose deploy` makes the same checks once.
 *
 * - On AWS only Bedrock models are checked: the Lambda's IAM role asks Bedrock's control plane,
 *   and no credential is read. API keys are checked at deploy, and a key that stops working
 *   later shows up as a run refused for auth (`CredentialProblem`).
 * - Under docker compose the runner already holds every provider's key, so it checks API-key
 *   models too.
 *
 * A provider with a model that can't be called reports `ModelUnavailable` 1, which alarms; one
 * whose every model passed reports 0. A check that couldn't run reports nothing, so a throttled
 * call neither raises nor clears the alarm.
 */

export const modelChecksSchema = z.array(
  z
    .object({
      providerId: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
      kind: z.enum(["bedrock", "anthropic-api", "openai-api"]),
      model: z.string().min(1).max(256),
      tiers: z.array(z.enum(["fast", "standard", "deep"])).min(1),
    })
    .strict(),
);

export interface ModelHealthDeps {
  checks: readonly ModelToCheck[];
  /** The region Bedrock models are called in. */
  region: string;
  /** Bedrock's control plane; without it, Bedrock models aren't checked. */
  bedrock?: BedrockModelApi;
  /** For API-key models: a status-only GET and the provider's stored key. */
  api?: { get: StatusGet; key(providerId: string): Promise<string | undefined> };
  /** `ModelUnavailable` for a provider: 1 with the problems, or 0 when every model passed. */
  report(providerId: string, value: 0 | 1, problems?: string[]): void;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** Runs the checks one at a time, reports each provider once, and returns what each found. */
export async function checkModels(deps: ModelHealthDeps): Promise<ModelCheckResult[]> {
  const results: ModelCheckResult[] = [];
  for (const check of deps.checks) {
    if (check.kind === "bedrock") {
      if (deps.bedrock !== undefined) {
        results.push(await checkBedrockModel(deps.bedrock, check, deps.region));
      }
      continue;
    }
    if (deps.api === undefined) continue;
    let key: string | undefined;
    try {
      key = await deps.api.key(check.providerId);
    } catch (error) {
      deps.log("model not checked: its provider's key couldn't be read", {
        providerId: check.providerId,
        error: error instanceof Error ? error.name : "error",
      });
      continue;
    }
    if (key !== undefined) results.push(await checkApiModel(deps.api.get, check, key));
  }
  const byProvider = new Map<string, ModelCheckResult[]>();
  for (const result of results) {
    byProvider.set(result.providerId, [...(byProvider.get(result.providerId) ?? []), result]);
    if (result.status !== "ok") {
      deps.log(result.status === "unavailable" ? "model unavailable" : "model not checked", {
        providerId: result.providerId,
        tiers: result.tiers,
        model: result.model,
        ...(result.kind === "bedrock" ? { region: deps.region } : {}),
        problem: result.problem,
        ...(result.fix === undefined ? {} : { fix: result.fix }),
      });
    }
  }
  for (const [providerId, found] of byProvider) {
    const unavailable = found.filter((result) => result.status === "unavailable");
    if (unavailable.length > 0) {
      deps.report(providerId, 1, unavailable.map(describeModelProblem));
    } else if (found.every((result) => result.status === "ok")) {
      deps.report(providerId, 0);
    }
  }
  return results;
}
