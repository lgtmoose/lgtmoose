/** Replaces every secret in the text with `***`. Short values are skipped, so a flag like "1" isn't. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (out, secret) => (secret.length >= MIN_SECRET_LENGTH ? out.split(secret).join("***") : out),
    text,
  );
}

/** Whether the text contains any of the secrets. */
export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length >= MIN_SECRET_LENGTH && text.includes(secret));
}

const MIN_SECRET_LENGTH = 8;
