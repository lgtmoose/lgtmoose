import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_VERSION,
  citedCode,
  codeOccurrence,
  commentTitle,
  dedupeFindings,
  fingerprint,
  fingerprintParts,
  isProtectedCategory,
  isSimilar,
  matchesExactlyOnly,
  normalizeCode,
  titleNouns,
  type FingerprintSubject,
} from "./fingerprint.js";

const subject = (overrides: Partial<FingerprintSubject> = {}): FingerprintSubject => ({
  ruleCategory: "correctness",
  path: "src/total.ts",
  title: "Loop skips the last item",
  code: ["  for (let i = 0; i < items.length - 1; i++) {"],
  ...overrides,
});

/** A subject as a comment from another source has it: no rule category. */
function withoutCategory(full: FingerprintSubject): FingerprintSubject {
  return { path: full.path, title: full.title, code: full.code };
}

describe("normalizeCode", () => {
  it("ignores whitespace and identifier names but keeps keywords and literals", () => {
    expect(normalizeCode(["if (user.role === 'admin')   return  limit + 10;"])).toEqual([
      "if",
      "(",
      "$id",
      ".",
      "$id",
      "=",
      "=",
      "=",
      "'admin'",
      ")",
      "return",
      "$id",
      "+",
      "10",
      ";",
    ]);
    expect(normalizeCode(["a  +  b"])).toEqual(normalizeCode(["x+y"]));
  });

  it("drops comments, so adding or editing one keeps the fingerprint", () => {
    expect(normalizeCode(["total += x; // fix later"])).toEqual(normalizeCode(["total += x;"]));
    expect(normalizeCode(["total += x /* note */;"])).toEqual(normalizeCode(["total += x;"]));
    expect(normalizeCode(["total += x  # python note"])).toEqual(normalizeCode(["total += x"]));
    expect(normalizeCode(["#include <x.h>"])).toContain("#");
  });

  it("treats names inside a template literal's interpolations as identifiers", () => {
    expect(normalizeCode(["log(`user ${user.id} denied`)"])).toEqual(
      normalizeCode(["log(`user ${account.key} denied`)"]),
    );
    expect(normalizeCode(["`a`"])).not.toEqual(normalizeCode(["`b`"]));
  });

  it("drops line breaks, so re-wrapped code matches", () => {
    expect(normalizeCode(["call(a,", "  b)"])).toEqual(normalizeCode(["call(a, b)"]));
  });
});

describe("titleNouns", () => {
  it("keeps key words, sorted, without stopwords, code or plurals", () => {
    expect(titleNouns("The `userId` check is missing for admin routes")).toEqual([
      "admin",
      "check",
      "route",
    ]);
  });

  it("drops identifier-like words and names from the code", () => {
    expect(titleNouns("orderTotal ignores the discount_rate on refunds v2", [])).toEqual([
      "ignore",
      "refund",
    ]);
    expect(titleNouns("account may be null", ["return account.name;"])).toEqual(["null"]);
    expect(titleNouns("Missing null check", ["if (user === null) return;"])).toEqual([
      "check",
      "null",
    ]);
  });

  it("keeps non-ASCII words whole", () => {
    expect(titleNouns("Überprüfung fehlt für Benutzer")).toEqual([
      "benutzer",
      "fehlt",
      "für",
      "überprüfung",
    ]);
  });

  it("keeps words ending in ss", () => {
    expect(titleNouns("Unchecked access")).toEqual(["access", "unchecked"]);
  });
});

describe("fingerprint", () => {
  it("is versioned and stable", () => {
    const print = fingerprint(subject());
    expect(print).toMatch(new RegExp(`^${FINGERPRINT_VERSION}:[0-9a-f]{32}$`));
    expect(fingerprint(subject())).toBe(print);
    expect(fingerprint(fingerprintParts(subject()))).toBe(print);
  });

  it("survives a renamed variable and re-indented code", () => {
    const renamed = subject({ code: ["for (let j = 0; j < rows.length - 1; j++) {"] });
    expect(fingerprint(renamed)).toBe(fingerprint(subject()));
  });

  it("survives a variable renamed in the title too", () => {
    const before = subject({ title: "items may be undefined here", code: ["return items[0];"] });
    const after = subject({ title: "rows may be undefined here", code: ["return rows[0];"] });
    expect(fingerprint(after)).toBe(fingerprint(before));
  });

  it("changes with the category, path, code or title", () => {
    const base = fingerprint(subject());
    expect(fingerprint(subject({ ruleCategory: "tests" }))).not.toBe(base);
    expect(fingerprint(subject({ path: "src/other.ts" }))).not.toBe(base);
    expect(fingerprint(subject({ code: ["for (let i = 0; i <= items.length; i++) {"] }))).not.toBe(
      base,
    );
    expect(fingerprint(subject({ title: "Total ignores tax" }))).not.toBe(base);
  });

  it("treats a missing category as empty", () => {
    expect(fingerprintParts(withoutCategory(subject())).ruleCategory).toBe("");
  });
});

describe("citedCode", () => {
  const file = [
    "export function total(items: Item[]): number {",
    "  let sum = 0;",
    "  for (const item of items) {",
    "    sum += item.price;",
    "  }",
    "",
    "  return sum;",
    "}",
  ];

  it("gives the cited line or range, either way round", () => {
    expect(citedCode(file, 4)).toEqual(["    sum += item.price;"]);
    expect(citedCode(file, 4, 3)).toEqual([
      "  for (const item of items) {",
      "    sum += item.price;",
    ]);
    expect(citedCode(file, 3, 4)).toEqual(citedCode(file, 4, 3));
  });

  it("widens a citation too short to identify code, skipping blank lines", () => {
    expect(citedCode(file, 5)).toEqual(["    sum += item.price;", "  }", "  return sum;"]);
  });

  it("stops at the file's edges and drops lines outside it", () => {
    expect(citedCode(["}"], 1)).toEqual(["}"]);
    expect(citedCode(file, 40)).toEqual([]);
    expect(citedCode(file, 1, -3)).toEqual(["export function total(items: Item[]): number {"]);
  });

  it("gives the same code after the lines moved", () => {
    const moved = ["// a new header comment", "", ...file];
    expect(citedCode(moved, 6)).toEqual(citedCode(file, 4));
  });
});

describe("commentTitle", () => {
  it("takes the first sentence, without markdown or code blocks", () => {
    expect(commentTitle("**Possible null deref.** The `user` can be missing.")).toBe(
      "Possible null deref.",
    );
    expect(commentTitle("<!-- bot:1 -->\n```ts\nx\n```\n## Missing auth check\nmore")).toBe(
      "Missing auth check",
    );
    expect(commentTitle("")).toBe("");
  });

  it("keeps underscores inside names but drops emphasis underscores", () => {
    expect(commentTitle("_Note:_ user_id is never checked")).toBe("Note: user_id is never checked");
  });

  it("caps the length", () => {
    expect(commentTitle("x".repeat(500))).toHaveLength(200);
  });
});

describe("isProtectedCategory", () => {
  it("knows the protected categories", () => {
    for (const category of ["authz", "tenant_scoping", "money", "secrets"]) {
      expect(isProtectedCategory(category)).toBe(true);
    }
    expect(isProtectedCategory("correctness")).toBe(false);
  });
});

describe("isSimilar", () => {
  const parts = fingerprintParts(subject());

  it("matches a reworded title about the same code", () => {
    const reworded = fingerprintParts(subject({ title: "Last item skipped by the loop bound" }));
    expect(isSimilar(parts, reworded)).toBe(true);
  });

  it("matches slightly changed code", () => {
    const longer = fingerprintParts(
      subject({ code: ["for (let i = 0; i < items.length - 1; i++) { // TODO"] }),
    );
    expect(isSimilar(parts, longer)).toBe(true);
  });

  it("matches a comment with no category", () => {
    const human = withoutCategory(subject({ title: "This loop skips the last item." }));
    expect(isSimilar(parts, fingerprintParts(human))).toBe(true);
  });

  it("doesn't match another path, category, code or problem", () => {
    expect(isSimilar(parts, fingerprintParts(subject({ path: "src/b.ts" })))).toBe(false);
    expect(isSimilar(parts, fingerprintParts(subject({ ruleCategory: "tests" })))).toBe(false);
    expect(isSimilar(parts, fingerprintParts(subject({ code: ["return sum * rate;"] })))).toBe(
      false,
    );
    expect(isSimilar(parts, fingerprintParts(subject({ title: "Missing test coverage" })))).toBe(
      false,
    );
  });

  it("needs identical code when a side has no key nouns, and some code at all", () => {
    const noNouns = fingerprintParts(subject({ title: "Why?" }));
    expect(isSimilar(parts, noNouns)).toBe(true);
    const otherCode = fingerprintParts(
      subject({ title: "Why?", code: ["for (let i = 0; i < items.length - 1; i++) { x }"] }),
    );
    expect(isSimilar(parts, otherCode)).toBe(false);
    expect(isSimilar(parts, fingerprintParts(subject({ code: [] })))).toBe(false);
  });

  it("compares single-token code", () => {
    const one = fingerprintParts(subject({ code: ["x"] }));
    expect(isSimilar(one, fingerprintParts(subject({ code: ["y"] })))).toBe(true);
  });
});

describe("dedupeFindings", () => {
  const candidate = (overrides: Partial<FingerprintSubject> = {}, id = "f") => ({
    finding: id,
    parts: fingerprintParts(subject(overrides)),
  });

  it("drops exact matches from any source and keeps new findings with their fingerprint", () => {
    const known = [{ fingerprint: fingerprint(subject()) }];
    const result = dedupeFindings(
      [candidate({}, "same"), candidate({ path: "b.ts" }, "new")],
      known,
    );
    expect(result.dropped).toEqual([
      { finding: "same", reason: "exact", matched: known[0]?.fingerprint },
    ]);
    expect(result.kept).toEqual([
      { finding: "new", fingerprint: fingerprint(subject({ path: "b.ts" })) },
    ]);
  });

  it("drops fuzzy matches when the known finding has parts", () => {
    const knownParts = fingerprintParts(subject({ title: "Last item skipped by the loop bound" }));
    const known = [{ fingerprint: fingerprint(knownParts), parts: knownParts }];
    const result = dedupeFindings([candidate()], known);
    expect(result.dropped).toEqual([
      { finding: "f", reason: "similar", matched: known[0]?.fingerprint },
    ]);
  });

  it("never drops a protected finding by a fuzzy match, only an exact one", () => {
    const protectedSubject = { ruleCategory: "authz", title: "Admin route skips the role check" };
    const knownParts = fingerprintParts(
      subject({ ...protectedSubject, title: "Role check skipped on admin route" }),
    );
    const fuzzy = dedupeFindings(
      [candidate(protectedSubject)],
      [{ fingerprint: fingerprint(knownParts), parts: knownParts }],
    );
    expect(fuzzy.kept).toHaveLength(1);
    const exact = dedupeFindings(
      [candidate(protectedSubject)],
      [{ fingerprint: fingerprint(subject(protectedSubject)) }],
    );
    expect(exact.dropped).toHaveLength(1);
  });

  it("drops a prompt-injection finding only on an exact match, like a protected one", () => {
    const injected = { ruleCategory: "prompt_injection", title: "Text aimed at an AI reviewer" };
    const lookalike = fingerprintParts(subject({ ruleCategory: "", title: "Text aimed at AI" }));
    const fuzzy = dedupeFindings(
      [candidate(injected)],
      [{ fingerprint: fingerprint(lookalike), parts: lookalike }],
    );
    expect(fuzzy.kept).toHaveLength(1);
    // The same look-alike drops an ordinary finding, so the exception is what keeps it.
    const ordinary = dedupeFindings(
      [candidate({ ...injected, ruleCategory: "security" })],
      [{ fingerprint: fingerprint(lookalike), parts: lookalike }],
    );
    expect(ordinary.dropped).toHaveLength(1);
    expect(matchesExactlyOnly("prompt_injection")).toBe(true);
    expect(matchesExactlyOnly("authz")).toBe(true);
    expect(matchesExactlyOnly("correctness")).toBe(false);
  });

  it("drops a repeat among the candidates themselves", () => {
    const result = dedupeFindings(
      [
        candidate({}, "first"),
        candidate({ title: "Last item skipped by the loop bound" }, "again"),
        candidate({}, "exact"),
      ],
      [],
    );
    expect(result.kept.map((k) => k.finding)).toEqual(["first"]);
    expect(result.dropped.map((d) => [d.finding, d.reason])).toEqual([
      ["again", "similar"],
      ["exact", "exact"],
    ]);
  });

  it("keeps everything when nothing is known", () => {
    expect(dedupeFindings([candidate()], []).dropped).toEqual([]);
  });
});

describe("codeOccurrence", () => {
  const FILE = [
    "export async function getUser(id: string) {",
    "  const user = await loadUser(id);",
    "  return user;",
    "}",
    "",
    "export async function getOrder(orderId: string) {",
    "  const order = await loadOrder(orderId);",
    "  return order;",
    "}",
  ];
  const TITLE = "Missing authorization check before loading the record";

  it("counts earlier same-shaped sites", () => {
    expect(codeOccurrence(FILE, 2)).toBe(0);
    expect(codeOccurrence(FILE, 7)).toBe(1);
  });

  it("keeps two problems on same-shaped lines apart, even in a protected category", () => {
    const at = (line: number) =>
      fingerprintParts({
        ruleCategory: "authz",
        path: "src/api.ts",
        title: TITLE,
        code: citedCode(FILE, line),
        occurrence: codeOccurrence(FILE, line),
      });
    const result = dedupeFindings(
      [
        { finding: "getUser", parts: at(2) },
        { finding: "getOrder", parts: at(7) },
      ],
      [],
    );
    expect(result.kept.map((k) => k.finding)).toEqual(["getUser", "getOrder"]);
    expect(isSimilar({ ...at(2), ruleCategory: "" }, { ...at(7), ruleCategory: "" })).toBe(false);
  });

  it("stays the same when lines move or names change", () => {
    const moved = ["// header", "", ...FILE.map((line) => line.replace(/order/gi, "invoice"))];
    expect(codeOccurrence(moved, 9)).toBe(1);
    const before = fingerprint({
      path: "a.ts",
      title: TITLE,
      code: citedCode(FILE, 7),
      occurrence: 1,
    });
    const after = fingerprint({
      path: "a.ts",
      title: TITLE,
      code: citedCode(moved, 9),
      occurrence: 1,
    });
    expect(after).toBe(before);
  });

  it("is 0 for code outside the file", () => {
    expect(codeOccurrence(FILE, 99)).toBe(0);
  });
});
