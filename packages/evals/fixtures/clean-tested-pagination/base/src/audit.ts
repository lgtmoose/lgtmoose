export interface AuditEntry {
  id: number;
  action: string;
  at: string;
}

/** Every entry, oldest first. */
export function listEntries(entries: readonly AuditEntry[]): AuditEntry[] {
  return [...entries].sort((a, b) => a.id - b.id);
}
