import { describe, expect, it } from "vitest";
import { importLines, languageOf } from "./imports.js";

const lines = (path: string, text: string) => [...importLines(path, text)];

describe("importLines", () => {
  it("JavaScript/TypeScript: single and multi-line imports, re-exports and require", () => {
    const text = [
      'import a from "a";',
      "import {",
      "  b,",
      '} from "b";',
      'import "side-effect";',
      'export * from "c";',
      'const d = require("d");',
      "export const x = 1;",
      "import type { T } from './t';",
    ].join("\n");
    expect(lines("x.ts", text)).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
  });

  it("Python, Go, Java, C#, Rust and C", () => {
    expect(
      lines("x.py", "import os\nfrom a import (\n  b,\n)\nfrom c import d, \\\n  e\nx = 1"),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lines("x.go", 'package x\n\nimport (\n\t"fmt"\n)\nimport "os"\n\nfunc f() {}')).toEqual([
      3, 4, 5, 6,
    ]);
    expect(lines("X.java", "package p;\nimport java.util.List;\nclass X {}")).toEqual([2]);
    expect(lines("X.cs", "using System;\nglobal using Foo.Bar;\nclass X {}")).toEqual([1, 2]);
    expect(lines("x.rs", "use std::{\n  io,\n};\nfn main() {}")).toEqual([1, 2, 3]);
    expect(lines("x.c", "#include <stdio.h>\nint main() {}")).toEqual([1]);
  });

  it("has no import lines for other files", () => {
    expect(languageOf("README.md")).toBeUndefined();
    expect(lines("README.md", "import this")).toEqual([]);
  });
});
