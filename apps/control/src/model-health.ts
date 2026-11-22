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
 * with none unavailable and at least one that passed (or is an active profile whose access can't
 * be read) reports 0. A check that couldn't run reports nothing, so a throttled call neither
 * raises nor clears the alarm.
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
  /** `ModelUnavailable` for a provider: 1 with the problems, or 0 when none is unavailable. */
  report(providerId: string, value: 0 | 1, problems?: string[]): void;
  log(message: string, fields?: Record<string, unknown>): void;
  /** Milliseconds the invocation has left (Lambda's `getRemainingTimeInMillis`). */
  remainingMs?: () => number;
}

/** No check is started with less than this left, so the ones already done are still reported. */
export const MODEL_CHECK_RESERVE_MS = 20_000;

/**
 * Runs the checks one at a time, provider by provider, reports each provider as soon as its
 * checks are done, and returns what each found. Stops starting checks when the invocation is
 * nearly out of time; a provider it didn't finish is reported only if a model was unavailable.
 */
export async function checkModels(deps: ModelHealthDeps): Promise<ModelCheckResult[]> {
  const results: ModelCheckResult[] = [];
  const bedrock = deps.checks.filter((check) => check.kind === "bedrock");
  if (deps.bedrock === undefined && bedrock.length > 0) {
    // Said once per run, so a skipped check is never mistaken for a passed one.
    deps.log("Bedrock models not checked: no Bedrock client here", {
      providers: [...new Set(bedrock.map((check) => check.providerId))],
    });
  }
  const byProvider = new Map<string, ModelToCheck[]>();
  for (const check of deps.checks) {
    byProvider.set(check.providerId, [...(byProvider.get(check.providerId) ?? []), check]);
  }
  const providers = [...byProvider];
  for (const [index, [providerId, checks]] of providers.entries()) {
    const found: ModelCheckResult[] = [];
    let finished = true;
    for (const check of checks) {
      const left = deps.remainingMs?.();
      if (left !== undefined && left < MODEL_CHECK_RESERVE_MS) {
        finished = false;
        break;
      }
      const result = await checkOne(deps, check);
      if (result === undefined) continue;
      found.push(result);
      logResult(deps, result);
    }
    results.push(...found);
    reportProvider(deps, providerId, found, finished);
    if (!finished) {
      deps.log("model checks stopped: the invocation is nearly out of time", {
        notFinished: providers.slice(index).map(([id]) => id),
      });
      break;
    }
  }
  return results;
}

/** One model's check, or nothing when it can't be made here (no client, no key). */
async function checkOne(
  deps: ModelHealthDeps,
  check: ModelToCheck,
): Promise<ModelCheckResult | undefined> {
  if (check.kind === "bedrock") {
    return deps.bedrock === undefined
      ? undefined
      : checkBedrockModel(deps.bedrock, check, deps.region);
  }
  if (deps.api === undefined) return undefined;
  let key: string | undefined;
  try {
    key = await deps.api.key(check.providerId);
  } catch (error) {
    deps.log("model not checked: its provider's key couldn't be read", {
      providerId: check.providerId,
      error: error instanceof Error ? error.name : "error",
    });
    return undefined;
  }
  if (key === undefined) {
    deps.log("model not checked: no stored key", {
      providerId: check.providerId,
      model: check.model,
    });
    return undefined;
  }
  return checkApiModel(deps.api.get, check, key);
}

const LOG_MESSAGES: Record<Exclude<ModelCheckResult["status"], "ok">, string> = {
  unavailable: "model unavailable",
  unverified: "model access not verified: the profile is active",
  unknown: "model not checked",
};

function logResult(deps: ModelHealthDeps, result: ModelCheckResult): void {
  if (result.status === "ok") return;
  deps.log(LOG_MESSAGES[result.status], {
    providerId: result.providerId,
    tiers: result.tiers,
    model: result.model,
    ...(result.kind === "bedrock" ? { region: deps.region } : {}),
    problem: result.problem,
    ...(result.fix === undefined ? {} : { fix: result.fix }),
  });
}

/**
 * 1 when a model is unavailable. 0 needs every model checked and one that passed or is an active
 * profile (`unverified`): a provider whose every check couldn't run reports nothing, and one model
 * that's always unknown can't keep the alarm up once the rest pass.
 */
function reportProvider(
  deps: ModelHealthDeps,
  providerId: string,
  found: ModelCheckResult[],
  finished: boolean,
): void {
  const unavailable = found.filter((result) => result.status === "unavailable");
  if (unavailable.length > 0) {
    deps.report(providerId, 1, unavailable.map(describeModelProblem));
  } else if (
    finished &&
    found.some((result) => result.status === "ok" || result.status === "unverified")
  ) {
    deps.report(providerId, 0);
  }
}

/**
 * The whole scheduled health check: the credential check, then the model checks, each
 * independent of the other. A model check that can't run at all (the runtime's Bedrock client
 * is missing a command, the checks don't parse) is logged and skipped, and the credential
 * result is returned as usual. A credential check that throws doesn't stop the model checks:
 * they run, and then its error is thrown again, so the invocation still fails and is retried.
 */
export async function healthCheck(deps: {
  credentials: () => Promise<Record<string, string | undefined>>;
  checks: () => ModelToCheck[];
  region: string;
  /** Bedrock's control plane, loaded only when a Bedrock model is checked. */
  bedrock: () => Promise<BedrockModelApi>;
  /** For API-key models, where the process holds the keys (docker compose). */
  api?: ModelHealthDeps["api"];
  report: ModelHealthDeps["report"];
  log: ModelHealthDeps["log"];
  remainingMs?: ModelHealthDeps["remainingMs"];
}): Promise<{ credentials: Record<string, string | undefined>; models: Record<string, string> }> {
  let credentials: Record<string, string | undefined> = {};
  let credentialError: { error: unknown } | undefined;
  try {
    credentials = await deps.credentials();
  } catch (error) {
    credentialError = { error };
  }
  const models = await checkAllModels(deps);
  if (credentialError !== undefined) throw credentialError.error;
  return { credentials, models };
}

/** The model half of `healthCheck`: never throws, and returns each model's status. */
async function checkAllModels(
  deps: Pick<
    Parameters<typeof healthCheck>[0],
    "checks" | "region" | "bedrock" | "api" | "report" | "log" | "remainingMs"
  >,
): Promise<Record<string, string>> {
  const models: Record<string, string> = {};
  try {
    const checks = deps.checks();
    if (checks.length === 0) return models;
    let bedrock: BedrockModelApi | undefined;
    if (checks.some((check) => check.kind === "bedrock")) {
      try {
        bedrock = await deps.bedrock();
      } catch (error) {
        deps.log("model checks not run: no Bedrock client", {
          error: error instanceof Error ? error.message : String(error),
        });
        return models;
      }
    }
    const results = await checkModels({
      checks,
      region: deps.region,
      ...(bedrock === undefined ? {} : { bedrock }),
      ...(deps.api === undefined ? {} : { api: deps.api }),
      ...(deps.remainingMs === undefined ? {} : { remainingMs: deps.remainingMs }),
      report: deps.report,
      log: deps.log,
    });
    for (const result of results) models[`${result.providerId}:${result.model}`] = result.status;
  } catch (error) {
    deps.log("model checks failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return models;
}
