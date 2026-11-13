import { describe, expect, it } from "vitest";
import { formatComment, suggestionBlock } from "./format.js";
import { buildReview, withCommentsInBody } from "./review.js";
import { fileDiff, finding } from "./testing/fixtures.js";

describe("formatComment", () => {
  it("shows severity, title, body and a suggestion", () => {
    const text = formatComment(finding({ suggestion: "  for (const item of items) {" }));
    expect(text).toBe(
      "**Blocking:** Off by one\n\nThe loop skips the last item\\.\n\n```suggestion\n  for (const item of items) {\n```",
    );
  });

  it("escapes the title and body so they can't add links, mentions or HTML", () => {
    const text = formatComment(
      finding({ title: "See [here](https://evil.example)", body: "@admin <img src=x> **bold**" }),
    );
    expect(text).not.toContain("](https://");
    expect(text).toContain("\\<img");
    expect(text).toContain("\\@\u2060admin");
  });

  it("uses a fence longer than any backtick run in the suggestion", () => {
    expect(suggestionBlock("a ```` b")).toBe("`````suggestion\na ```` b\n`````");
  });
});

describe("buildReview", () => {
  const files = [fileDiff()];

  it("puts findings in hunks inline and the rest in the body as path:line", () => {
    const review = buildReview({
      event: "REQUEST_CHANGES",
      inline: [finding(), finding({ line: 120, title: "Far away" })],
      outsideDiff: [finding({ severity: "should_fix", line: 2, title: "Elsewhere" })],
      files,
      nitCap: 10,
    });
    expect(review.comments).toEqual([
      expect.objectContaining({ path: "src/total.ts", line: 9, side: "RIGHT" }),
    ]);
    expect(review.inBody.map((f) => f.title)).toEqual(["Elsewhere", "Far away"]);
    expect(review.body).toContain("src\\/total\\.ts:120");
    expect(review.body).toContain("src\\/total\\.ts:2");
  });

  it("puts a finding on a file outside the PR into the body", () => {
    const review = buildReview({
      event: "COMMENT",
      inline: [finding({ path: "src/other.ts" })],
      outsideDiff: [],
      files,
      nitCap: 10,
    });
    expect(review.comments).toEqual([]);
    expect(review.inBody).toHaveLength(1);
  });

  it("caps nits and says how many were left out", () => {
    const nit = (line: number) => finding({ severity: "nit", line, title: `Nit ${line}` });
    const review = buildReview({
      event: "COMMENT",
      inline: [nit(9), nit(10), finding()],
      outsideDiff: [nit(2)],
      files,
      nitCap: 1,
    });
    expect(review.comments).toHaveLength(2);
    expect(review.nitsLeftOut).toBe(2);
    expect(review.body).toContain("2 more nits were left out");
  });

  it("always has a body", () => {
    const review = buildReview({
      event: "APPROVE",
      inline: [],
      outsideDiff: [],
      files,
      nitCap: 10,
    });
    expect(review.body).not.toBe("");
  });

  it("offers suggestions only on the new version of a file", () => {
    const review = buildReview({
      event: "COMMENT",
      inline: [finding({ side: "LEFT", line: 9, suggestion: "x" })],
      outsideDiff: [],
      files,
      nitCap: 10,
    });
    expect(review.comments[0]?.side).toBe("LEFT");
    expect(review.comments[0]?.body).not.toContain("suggestion");
  });

  it("moves every inline comment into the body for the retry", () => {
    const review = buildReview({
      event: "COMMENT",
      inline: [finding()],
      outsideDiff: [],
      files,
      nitCap: 0,
    });
    const retry = withCommentsInBody(review);
    expect(retry.comments).toEqual([]);
    expect(retry.inBody).toHaveLength(1);
    expect(retry.body).toContain("src\\/total\\.ts:9");
  });
});
