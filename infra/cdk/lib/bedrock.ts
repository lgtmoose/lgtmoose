import { isModelAlias, TIERS, type ProviderConfig } from "@lgtmoose/config";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

/** Cross-region inference profile prefixes, such as the `us.` in `us.anthropic.claude-…`. */
const PROFILE_PREFIX = /^(?:us-gov|us|eu|apac|jp|au|global)\./;

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
  const pinned = TIERS.map((tier) => provider.models?.[tier]);
  const exact = pinned.every(
    (model) =>
      model !== undefined &&
      !isModelAlias(model) &&
      !model.startsWith("arn:") &&
      model.replace(PROFILE_PREFIX, "").startsWith("anthropic."),
  );
  const models = exact ? [...new Set(pinned as string[])] : [];
  // A tier pinned to a Bedrock ARN, such as an application inference profile, is allowed as
  // given; the model it routes to is covered by the Anthropic foundation-model wildcard below.
  const arns = [
    ...new Set(pinned.filter((model): model is string => model?.startsWith("arn:") === true)),
  ];
  const profiles = exact
    ? [
        ...new Set(
          models
            .filter((model) => PROFILE_PREFIX.test(model))
            .map((model) => `arn:${partition}:bedrock:*:${account}:inference-profile/${model}`),
        ),
      ]
    : [`arn:${partition}:bedrock:*:${account}:inference-profile/*anthropic.*`, ...arns];
  const foundation = exact
    ? [
        ...new Set(
          models.map(
            (model) =>
              `arn:${partition}:bedrock:*::foundation-model/${model.replace(PROFILE_PREFIX, "")}`,
          ),
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
