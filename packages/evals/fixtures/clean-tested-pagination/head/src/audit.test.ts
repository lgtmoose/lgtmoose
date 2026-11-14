import { describe, expect, it } from "vitest";
import { MAX_LIMIT, listEntries, type AuditEntry } from "./audit.js";

const entries: AuditEntry[] = [3, 1, 2, 5, 4].map((id) => ({ id, action: "login", at: "2026-01-01" }));

describe("listEntries", () => {
  it("returns pages in id order with a cursor to the next one", () => {
    const first = listEntries(entries, { limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual([1, 2]);
    expect(first.next).toBe(2);
    const second = listEntries(entries, { limit: 2, after: first.next });
    expect(second.entries.map((e) => e.id)).toEqual([3, 4]);
    const last = listEntries(entries, { limit: 2, after: second.next });
    expect(last.entries.map((e) => e.id)).toEqual([5]);
    expect(last.next).toBeUndefined();
  });

  it("clamps the limit, and uses the default when it isn't a number", () => {
    expect(listEntries(entries, { limit: 0 }).entries).toHaveLength(1);
    expect(listEntries(entries, { limit: Number.NaN }).entries).toHaveLength(5);
    expect(listEntries(entries, { after: Number.NaN }).entries).toHaveLength(5);
    const many = Array.from({ length: MAX_LIMIT + 10 }, (_, i) => ({ id: i + 1, action: "x", at: "" }));
    expect(listEntries(many, { limit: 10_000 }).entries).toHaveLength(MAX_LIMIT);
  });
});
