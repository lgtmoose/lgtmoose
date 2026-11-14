export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** Secrets Manager's message for a secret that's scheduled for deletion. */
const SCHEDULED_FOR_DELETION = /(scheduled|marked) for deletion/i;

/**
 * Secrets Manager refuses most calls on a secret scheduled for deletion with this error. To a
 * reader it means the secret is gone; a writer has to restore it first.
 */
export function isScheduledForDeletion(error: unknown): boolean {
  return (
    errorName(error) === "InvalidRequestException" &&
    error instanceof Error &&
    SCHEDULED_FOR_DELETION.test(error.message)
  );
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
