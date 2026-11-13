export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** The AWS SDK's names for "no usable credentials". */
const CREDENTIAL_ERRORS = new Set([
  "CredentialsProviderError",
  "ExpiredToken",
  "ExpiredTokenException",
  "TokenRefreshRequired",
]);

/**
 * Wraps an AWS SDK error with the service, region and resource, and a sign-in hint when the
 * credentials are missing or expired. AWS error messages never contain secret values.
 */
export function awsError(service: string, region: string, what: string, error: unknown): Error {
  const hint = CREDENTIAL_ERRORS.has(errorName(error) ?? "")
    ? " Sign in to AWS first (for example `aws sso login`), then try again."
    : "";
  const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
  return new Error(`AWS ${service} (${region}) failed on ${what}: ${message}.${hint}`, {
    cause: error,
  });
}
