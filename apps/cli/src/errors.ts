/** Any thrown value's message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Any thrown value's message, without a trailing full stop, for putting inside a sentence. */
export function errorText(error: unknown): string {
  return errorMessage(error).replace(/\.$/, "");
}
