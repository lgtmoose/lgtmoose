/**
 * @lgtmoose/core holds the deterministic parts of a review: no model calls, no I/O.
 * Fingerprints (NIC-814) and the review decision (NIC-815) land here next.
 */

export const SEVERITIES = ["blocking", "should_fix", "nit"] as const;

export type Severity = (typeof SEVERITIES)[number];

/** Lower rank means more severe. Used to sort findings, most severe first. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}
