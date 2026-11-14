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
      from: 0,
      to: 0,
      at: 0,
    });
  });

  it("adds a short line's non-blank neighbours, and knows which lines are the finding's", () => {
    // `  }` alone is one token: a non-blank line each side.
    expect(lineSpan(FILE, 6)).toEqual({
      lines: ["sum += items[i].price;", "}", "return sum;"],
      from: 1,
      to: 1,
      at: 1,
    });
    // `let sum = 0;` skips the blank line below it.
    expect(lineSpan(FILE, 2, 1)).toMatchObject({ from: 0, to: 1, at: 1 });
  });

  it("has nothing to go by for a blank line or one outside the file", () => {
    expect(lineSpan(FILE, 3)).toBeUndefined();
    expect(lineSpan(FILE, 99)).toBeUndefined();
  });
});

describe("findSpan", () => {
  const brace = lineSpan(FILE, 6);
  const loop = lineSpan(FILE, 4);
  if (brace === undefined || loop === undefined) throw new Error("expected spans");

  it("finds the finding's own lines anywhere, however far", () => {
    const moved = [...Array.from({ length: 300 }, (_, i) => `// ${i}`), ...FILE];
    expect(findSpan(moved, loop, 4)).toBe(304);
  });

  it("finds a single place by the finding's own lines, whatever its neighbours are now", () => {
    // The loop line's neighbours change; it's still the only such line.
    const edited = FILE.map((line) =>
      line === "    sum += items[i].price;" ? "    sum += 1;" : line,
    );
    expect(findSpan(edited, loop, 4)).toBe(4);
    // The only `}` there is, with other neighbours.
    expect(findSpan(["  x = 1;", "  }", "  y = 2;"], brace, 6)).toBe(2);
  });

  it("among several places, takes those whose neighbours match too, then the nearest", () => {
    const twice = [...FILE, ...FILE];
    // The loop lines: 4 and 12.
    expect(findSpan(twice, loop, 7)).toBe(4);
    expect(findSpan(twice, loop, 9)).toBe(12);
    expect(findSpan(twice, loop, 8)).toBe(4);
    // The `}` lines: 6, 8, 14, 16. Only 6 and 14 have the loop's neighbours.
    expect(findSpan(twice, brace, 9)).toBe(6);
    expect(findSpan(twice, brace, 15)).toBe(14);
  });

  it("doesn't guess between several short places when none's neighbours match", () => {
    const rewritten = FILE.map((line) =>
      line === "    sum += items[i].price;" ? "    sum += discounted(items[i]);" : line,
    );
    // `}` on lines 6 and 8, neither with the loop's neighbours.
    expect(findSpan(rewritten, brace, 6)).toBeUndefined();
    // A longer own line, several places: the nearest.
    const twice = [...FILE, "", ...FILE.slice(3, 4)];
    expect(findSpan(twice, { ...loop }, 9)).toBe(10);
  });

  it("ignores whitespace and blank lines", () => {
    const spaced = ["    sum  +=  items[i].price;", "", "  }", "", "  return sum;", "}"];
    expect(findSpan(spaced, brace, 1)).toBe(3);
  });

  it("takes only lines `allowed` takes", () => {
    const twice = [...FILE, ...FILE];
    expect(findSpan(twice, brace, 6, (line) => line > 8)).toBe(14);
  });
});

describe("spans as stored", () => {
  it("round-trip, and anything else reads as none", () => {
    const span = { lines: ["}", "return sum;"], from: 0, to: 0, at: 0 };
    expect(decodeSpan(encodeSpan(span))).toEqual(span);
    for (const text of [
      undefined,
      "return sum;",
      "{}",
      '{"lines":["a"],"from":0,"to":0,"at":1}',
      '{"lines":["a","b"],"from":1,"to":1,"at":0}',
    ]) {
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
