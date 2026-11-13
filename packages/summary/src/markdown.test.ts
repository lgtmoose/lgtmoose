import { describe, expect, it } from "vitest";
import { clip, inline, link, paragraphs } from "./markdown.js";

const J = "\u2060";

describe("inline", () => {
  it("makes table-breaking, HTML and formatting characters literal", () => {
    expect(inline("a | b <details> **x** [l](u) `c`")).toBe(
      "a \\| b \\<details\\> \\*\\*x\\*\\* \\[l\\]\\(u\\) \\`c\\`",
    );
  });

  it("stops mentions and issue references", () => {
    expect(inline("ping @octocat about #12")).toBe(`ping \\@${J}octocat about \\#${J}12`);
  });

  it("puts everything on one line", () => {
    expect(inline(" one\ntwo\r\n\tthree ")).toBe("one two three");
  });
});

describe("paragraphs", () => {
  it("keeps paragraphs and line breaks but escapes each line", () => {
    expect(paragraphs("# Title\n- item\n\n\n> quote")).toBe(
      "\\#\u2060 Title\\\n\\- item\n\n\\> quote",
    );
  });
});

describe("clip", () => {
  it("cuts at a word boundary with an ellipsis", () => {
    expect(clip("one two three four", 10)).toBe("one two…");
    expect(clip("short", 10)).toBe("short");
  });
});

describe("link", () => {
  it("links http(s) URLs only", () => {
    expect(link("NIC-1", "https://linear.app/x/issue/NIC-1")).toBe(
      "[NIC\\-1](https://linear.app/x/issue/NIC-1)",
    );
    expect(link("x", "javascript:alert(1)")).toBe("x");
    expect(link("x", "not a url")).toBe("x");
    expect(link("x", "https://e.com/a(b)")).toBe("[x](https://e.com/a%28b%29)");
  });
});
