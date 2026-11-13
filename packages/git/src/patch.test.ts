import { describe, expect, it } from "vitest";
import { parsePatch, unquotePath } from "./patch.js";

describe("parsePatch", () => {
  it("numbers lines on both sides and skips the no-newline marker", () => {
    const [file] = parsePatch(
      [
        "diff --git a/x.txt b/x.txt",
        "index 1111111..2222222 100644",
        "--- a/x.txt",
        "+++ b/x.txt",
        "@@ -2,3 +2,3 @@ function f() {",
        " keep",
        "-old",
        "+new",
        " tail",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(file).toMatchObject({ oldPath: "x.txt", newPath: "x.txt", binary: false });
    expect(file?.hunks[0]).toMatchObject({
      oldStart: 2,
      oldLines: 3,
      newStart: 2,
      newLines: 3,
      section: "function f() {",
    });
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: "context", oldLine: 2, newLine: 2, text: "keep" },
      { kind: "del", oldLine: 3, text: "old" },
      { kind: "add", newLine: 3, text: "new" },
      { kind: "context", oldLine: 4, newLine: 4, text: "tail" },
    ]);
  });

  it("reads content lines that look like headers as content", () => {
    const [file] = parsePatch(
      [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1 +1 @@",
        "--- a/not-a-header",
        "+++ b/also-content",
        "",
      ].join("\n"),
    );
    expect(file?.hunks[0]?.lines.map((l) => l.kind)).toEqual(["del", "add"]);
    expect(file?.newPath).toBe("x");
  });

  it("takes renames, new files and binaries from the extended headers", () => {
    const files = parsePatch(
      [
        "diff --git a/old name.ts b/new name.ts",
        "similarity index 100%",
        "rename from old name.ts",
        "rename to new name.ts",
        "diff --git a/img.png b/img.png",
        "new file mode 100644",
        "Binary files /dev/null and b/img.png differ",
        "",
      ].join("\n"),
    );
    expect(files[0]).toMatchObject({ oldPath: "old name.ts", newPath: "new name.ts", hunks: [] });
    expect(files[1]).toMatchObject({ oldPath: undefined, newPath: "img.png", binary: true });
  });
});

describe("unquotePath", () => {
  it("decodes git's C-style quoting, including UTF-8 octal escapes", () => {
    expect(unquotePath('"a\\tb\\"c\\\\d"')).toBe('a\tb"c\\d');
    expect(unquotePath('"caf\\303\\251.txt"')).toBe("café.txt");
    expect(unquotePath("plain.txt")).toBe("plain.txt");
  });
});
