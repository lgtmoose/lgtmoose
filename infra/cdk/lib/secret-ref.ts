import type { ISecret } from "aws-cdk-lib/aws-secretsmanager";

/**
 * A secret's ARN for IAM. A secret referenced by name has no full ARN; this matches it with the
 * six random characters Secrets Manager adds.
 */
export function secretArnPattern(secret: ISecret): string {
  return secret.secretFullArn ?? `${secret.secretArn}-??????`;
}

/**
 * An id `GetSecretValue` accepts.
 *
 * A secret this stack creates has a full ARN. A secret imported by name does not: its ARN stops
 * before the random suffix. When that name ends in a hyphen and six characters, Secrets Manager
 * reads the ending as the suffix and looks up a different secret. `lgtmoose/github-webhook-secret`
 * is looked up as `lgtmoose/github-webhook`, so the call returns not found. The name always
 * resolves, and so does a full ARN.
 */
export function secretId(secret: ISecret): string {
  return secret.secretFullArn ?? secret.secretName;
}

/**
 * Whether a partial ARN of this name names a different secret. Secrets Manager takes a final
 * `-` plus six letters or digits as the random suffix and drops it from the name.
 */
export function partialArnHidesName(name: string): boolean {
  return /-[A-Za-z0-9]{6}$/.test(name);
}
