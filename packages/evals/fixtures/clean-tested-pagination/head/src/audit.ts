export interface AuditEntry {
  id: number;
  action: string;
  at: string;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Page {
  entries: AuditEntry[];
  /** Pass as `after` for the next page; undefined on the last page. */
  next: number | undefined;
}

/**
 * Entries after the id `after`, oldest first, at most `limit`: clamped to 1..MAX_LIMIT, and
 * DEFAULT_LIMIT when it's missing or not a number.
 */
export function listEntries(
  entries: readonly AuditEntry[],
  options: { limit?: number; after?: number } = {},
): Page {
  const requested =
    options.limit !== undefined && Number.isFinite(options.limit) ? Math.trunc(options.limit) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
  const after = options.after ?? 0;
  const sorted = [...entries].filter((entry) => entry.id > after).sort((a, b) => a.id - b.id);
  const page = sorted.slice(0, limit);
  const last = page.at(-1);
  return { entries: page, next: sorted.length > limit && last !== undefined ? last.id : undefined };
}
