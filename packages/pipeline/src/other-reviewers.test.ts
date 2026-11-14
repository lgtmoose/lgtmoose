import { describe, expect, it } from "vitest";
import {
  otherReviewerFindings,
  otherReviewerSeverity,
  reviewerMisses,
  type OtherReviewerOptions,
} from "./other-reviewers.js";
import type { PullComment } from "./pull.js";

const options: OtherReviewerOptions = {
  paths: new Set(["src/a.ts", "src/b.ts"]),
  resolved: new Set(),
  ourAppId: 42,
  ourCommentIds: new Set(),
};

function comment(
  overrides: { [K in keyof PullComment]?: PullComment[K] | undefined } = {},
): PullComment {
  // An override of `undefined` leaves the field out, as GitHub would.
  const base: Record<string, unknown> = {
    id: 100,
    author: "coderabbitai[bot]",
    authorType: "bot",
    body: "_⚠️ Potential issue_ | _🔴 Critical_\n\n**SQL injection.** The query concatenates input.",
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    url: "https://github.com/acme/shop/pull/1#discussion_r100",
    ...overrides,
  };
  for (const [key, value] of Object.entries(base)) if (value === undefined) delete base[key];
  return base as unknown as PullComment;
}

describe("otherReviewerSeverity", () => {
  it("reads the severity review bots and people mark", () => {
    expect(otherReviewerSeverity("_🔴 Critical_ SQL injection")).toBe("blocking");
    expect(otherReviewerSeverity("_🟠 Major_ Missing await")).toBe("should_fix");
    expect(otherReviewerSeverity("_⚠️ Potential issue_ off by one")).toBe("should_fix");
    expect(otherReviewerSeverity("Bug: this never resets the counter")).toBe("should_fix");
  });

  it("doesn't count nits, ideas or questions, or a word far into the comment", () => {
    expect(otherReviewerSeverity("_🛠️ Refactor suggestion_ | _🔵 Trivial_")).toBeUndefined();
    expect(otherReviewerSeverity("Why is this here?")).toBeUndefined();
    expect(otherReviewerSeverity("debugging leftover?")).toBeUndefined();
    expect(otherReviewerSeverity(`${"x".repeat(400)} critical`)).toBeUndefined();
  });
});

describe("otherReviewerFindings", () => {
  it("counts another bot's Critical comment as a blocking finding, without its text", () => {
    const [found, ...rest] = otherReviewerFindings([comment()], options);
    expect(rest).toEqual([]);
    expect(found).toMatchObject({ source: "bot", login: "coderabbitai[bot]", commentId: 100 });
    expect(found?.finding).toMatchObject({
      rule_category: "other_reviewer",
      severity: "blocking",
      path: "src/a.ts",
      line: 10,
      title: "Raised by coderabbitai[bot] in their review comment",
    });
    expect(JSON.stringify(found?.finding)).not.toContain("SQL injection");
  });

  it("counts a person's comment only when they have a say in the repository", () => {
    const person = (association: string) =>
      comment({ author: "alice", authorType: "human", association, body: "Bug: wrong total" });
    expect(otherReviewerFindings([person("MEMBER")], options)).toHaveLength(1);
    expect(otherReviewerFindings([person("COLLABORATOR")], options)).toHaveLength(1);
    expect(otherReviewerFindings([person("CONTRIBUTOR")], options)).toEqual([]);
    expect(otherReviewerFindings([person("NONE")], options)).toEqual([]);
    expect(otherReviewerFindings([comment({ authorType: "human" })], options)).toEqual([]);
  });

  it("leaves out ours, replies, resolved threads, outdated comments and other files", () => {
    const left = [
      comment({ viaAppId: 42 }),
      comment({ id: 7 }),
      comment({ inReplyTo: 99 }),
      comment({ id: 8 }),
      comment({ id: 9, line: undefined }),
      comment({ id: 10, path: "vendor/x.js" }),
      comment({ id: undefined }),
      comment({ id: 11, body: "Nit: rename this" }),
    ];
    const found = otherReviewerFindings(left, {
      ...options,
      ourCommentIds: new Set([7]),
      resolved: new Set([8]),
    });
    expect(found).toEqual([]);
  });

  it("never puts an untrusted login or link into the summary", () => {
    const [found] = otherReviewerFindings(
      [comment({ author: "evil](https://x.example) @team", url: "javascript:alert(1)" })],
      options,
    );
    expect(found?.finding.title).toBe("Raised by unknown in their review comment");
    expect(found?.finding.body).toBe("See their comment on this line.");
  });
});

describe("reviewerMisses", () => {
  const [other] = otherReviewerFindings([comment()], options);
  if (other === undefined) throw new Error("no finding");

  it("records a finding on a file we reviewed that none of ours is near", () => {
    expect(reviewerMisses([other], new Set(["src/a.ts"]), [])).toEqual([
      { path: "src/a.ts", line: 10, severity: "blocking", source: "bot" },
    ]);
  });

  it("isn't a miss when one of ours is within a few lines, or the file wasn't reviewed", () => {
    expect(
      reviewerMisses([other], new Set(["src/a.ts"]), [{ path: "src/a.ts", line: 12 }]),
    ).toEqual([]);
    expect(reviewerMisses([other], new Set(["src/b.ts"]), [])).toEqual([]);
  });
});
