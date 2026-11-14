/** Structured logs, one JSON line each, shipped to the log store. */
export const logger = {
  info(message: string, fields: Record<string, unknown> = {}): void {
    process.stdout.write(`${JSON.stringify({ level: "info", message, ...fields })}\n`);
  },
};
