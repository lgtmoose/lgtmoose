/** One JSON line on stdout, for CloudWatch. Fields must never hold a credential. */
export function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ message, ...fields })}\n`);
}
