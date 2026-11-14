import { describe, expect, it } from "vitest";
import { decodeSpan, encodeSpan, fileLines, findSpan, lineSpan, normaliseLine } from "./span.js";

const FILE = [
  "export function total(items: Item[]): number {",
  "  let sum = 0;",
  "",
  "  for (let i = 0; i < items.length; i++) {",
  "    sum += items[i].price;",
  "  }",
  "  return sum;",
  "}",
];

describe("lineSpan", () => {
  it("keeps a line long enough on its own", () => {
    expect(lineSpan(FILE, 4)).toEqual({
      lines: ["for (let i = 0; i < items.length; i++) {"],
      at: 0,
    });
  });

  it("widens a short line with its non-blank neighbours, and knows which is the finding's", () => {
    // `  }` alone is one token: widened by one non-blank line each side.
    expect(lineSpan(FILE, 6)).toEqual({
      lines: ["sum += items[i].price;", "}", "return sum;"],
      at: 1,
    });
    // `let sum = 0;` skips the blank line below it.
    expect(lineSpan(FILE, 2, 1)?.lines).toHaveLength(2);
  });

  it("has nothing to go by for a blank line or one outside the file", () => {
    expect(lineSpan(FILE, 3)).toBeUndefined();
    expect(lineSpan(FILE, 99)).toBeUndefined();
  });
});

describe("findSpan", () => {
  const span = lineSpan(FILE, 6);
  if (span === undefined) throw new Error("expected a span");

  it("finds the span anywhere, the nearest to where it was, earlier on a tie", () => {
    const moved = [...Array.from({ length: 300 }, (_, i) => `// ${i}`), ...FILE];
    expect(findSpan(moved, span, 6)).toBe(306);
    // Two copies the same distance away: the earlier one.
    const twice = [...FILE, ...FILE];
    expect(findSpan(twice, span, 10)).toBe(6);
    expect(findSpan(twice, span, 13)).toBe(14);
  });

  it("matches the whole span, not just the finding's short line", () => {
    const other = ["function f() {", "  g();", "  }", "  return 1;", "}"];
    expect(findSpan(other, span, 3)).toBeUndefined();
  });

  it("ignores whitespace and blank lines between the span's lines", () => {
    const spaced = ["    sum  +=  items[i].price;", "", "  }", "", "  return sum;"];
    expect(findSpan(spaced, span, 1)).toBe(3);
  });

  it("takes only lines `allowed` takes", () => {
    const twice = [...FILE, ...FILE];
    expect(findSpan(twice, span, 6, (line) => line > 8)).toBe(14);
  });
});

describe("spans as stored", () => {
  it("round-trip, and anything else reads as none", () => {
    const span = { lines: ["}", "return sum;"], at: 0 };
    expect(decodeSpan(encodeSpan(span))).toEqual(span);
    for (const text of [undefined, "return sum;", "{}", '{"lines":["a"],"at":1}']) {
      expect(decodeSpan(text)).toBeUndefined();
    }
  });
});

describe("helpers", () => {
  it("normalises whitespace and drops the empty element after a final newline", () => {
    expect(normaliseLine("  a \t  b  ")).toBe("a b");
    expect(fileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("a\nb")).toEqual(["a", "b"]);
  });
});
