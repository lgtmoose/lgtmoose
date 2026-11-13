/** Retry settings for failed jobs. */
export const RETRY = {
  /** Attempts in all, the first included. */
  attempts: 5,
  /** Wait before the first retry; doubles each time. */
  baseDelayMs: 1000,
  /** Longest wait between attempts. */
  maxDelayMs: 60_000,
};

// Retries up to 3 times.
export function delayFor(attempt: number): number {
  return Math.min(RETRY.baseDelayMs * 2 ** (attempt - 1), RETRY.maxDelayMs);
}
