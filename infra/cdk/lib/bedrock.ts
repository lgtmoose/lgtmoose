import {
  BEDROCK_MODEL_ID,
  MODEL_MODIFIER,
  isModelAlias,
  modelFor,
  TIERS,
  type ModelToCheck,
  type ProviderConfig,
} from "@lgtmoose/config";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

/**
 * The IAM statements a Bedrock provider's sandbox task role needs, scoped to Anthropic's models
 * (https://code.claude.com/docs/en/amazon-bedrock#iam-configuration):
 * - invoking the pinned models, and their cross-region inference profiles, in any region a
 *   profile routes to; or every Anthropic model and profile when a tier uses an alias, which
 *   Claude Code resolves to a model ID itself;
 * - listing inference profiles, which Claude Code does to resolve model IDs.
 */
export function bedrockStatements(
  provider: ProviderConfig,
  partition: string,
  account: string,
): PolicyStatement[] {
  const pinned = TIERS.map((tier) => modelFor(provider, tier));
  // The ID Claude Code calls: without a `[1m]`-style modifier.
  const ids = pinned.map((model) =>
    model === undefined || isModelAlias(model)
      ? undefined
      : (BEDROCK_MODEL_ID.exec(model.replace(MODEL_MODIFIER, "")) ?? undefined),
  );
  const exact = ids.every((id) => id !== undefined);
  // A tier pinned to a Bedrock ARN, such as an application inference profile, is allowed as
  // given; the model it routes to is covered by the Anthropic foundation-model wildcard below.
  const arns = [
    ...new Set(
      pinned
        .filter((model): model is string => model?.startsWith("arn:") === true)
        .map((arn) => arn.replace(MODEL_MODIFIER, "")),
    ),
  ];
  const matches = exact ? (ids as RegExpExecArray[]) : [];
  const profiles = exact
    ? [
        ...new Set(
          matches
            .filter((match) => match[1] !== undefined)
            .map((match) => `arn:${partition}:bedrock:*:${account}:inference-profile/${match[0]}`),
        ),
      ]
    : [`arn:${partition}:bedrock:*:${account}:inference-profile/*anthropic.*`, ...arns];
  const foundation = exact
    ? [
        ...new Set(
          matches.map((match) => `arn:${partition}:bedrock:*::foundation-model/${match[2]}`),
        ),
      ]
    : [`arn:${partition}:bedrock:*::foundation-model/anthropic.*`];
  return [
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [...foundation, ...profiles],
    }),
    // ListInferenceProfiles has no resource-level permissions.
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:ListInferenceProfiles"],
      resources: ["*"],
    }),
    ...(profiles.length === 0
      ? []
      : [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["bedrock:GetInferenceProfile"],
            resources: profiles,
          }),
        ]),
  ];
}

/** Context-window variants such as `…-v1:0:200k` share their base model's access. */
const CONTEXT_VARIANT = /:\d+k$/;

/**
 * The IAM statements the health check needs to ask Bedrock about the pinned models (NIC-1121):
 * describing each inference profile and foundation model, in the stack's region only. It never
 * gets `bedrock:InvokeModel`, so it can't call a model. `GetFoundationModelAvailability` has no
 * resource-level permissions, and only reads the account's model access and agreements.
 */
export function modelCheckStatements(
  checks: readonly ModelToCheck[],
  partition: string,
  region: string,
  account: string,
): PolicyStatement[] {
  const ids = checks
    .filter((check) => check.kind === "bedrock")
    .map((check) => BEDROCK_MODEL_ID.exec(check.model))
    .filter((match): match is RegExpExecArray => match?.[2] !== undefined);
  if (ids.length === 0) return [];
  const profiles = [
    ...new Set(
      ids
        .filter((match) => match[1] !== undefined)
        .map(
          (match) => `arn:${partition}:bedrock:${region}:${account}:inference-profile/${match[0]}`,
        ),
    ),
  ];
  // Only a bare model ID is described: a profile is checked through GetInferenceProfile.
  const models = [
    ...new Set(
      ids
        .filter((match) => match[1] === undefined)
        .map(
          (match) =>
            `arn:${partition}:bedrock:${region}::foundation-model/${(match[2] ?? "").replace(CONTEXT_VARIANT, "")}`,
        ),
    ),
  ];
  const statement = (action: string, resources: string[]) =>
    resources.length === 0
      ? []
      : [new PolicyStatement({ effect: Effect.ALLOW, actions: [action], resources })];
  return [
    ...statement("bedrock:GetInferenceProfile", profiles),
    ...statement("bedrock:GetFoundationModel", models),
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["bedrock:GetFoundationModelAvailability"],
      resources: ["*"],
    }),
  ];
}
