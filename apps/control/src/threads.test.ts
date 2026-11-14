import { describe, expect, it } from "vitest";
import { graphQlThreadReader, type GraphQl } from "./threads.js";

const TARGET = { owner: "acme", repo: "shop", number: 7 };

function page(
  nodes: unknown[],
  next?: string,
): { data: { repository: { pullRequest: { reviewThreads: unknown } } } } {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
            nodes,
          },
        },
      },
    },
  };
}

const thread = (isResolved: boolean, fullDatabaseId: string | null) => ({
  isResolved,
  comments: { nodes: [{ fullDatabaseId }] },
});

describe("graphQlThreadReader", () => {
  it("reads every page of the PR's threads, with each first comment's ID", async () => {
    const calls: Record<string, unknown>[] = [];
    const replies = [
      // Past 2^31, as review-comment IDs are now.
      page([thread(true, "3000000011"), thread(false, "12")], "cursor-1"),
      page([thread(true, null), { isResolved: false, comments: { nodes: [] } }, null]),
    ];
    const graphql: GraphQl = async (query, variables) => {
      expect(query).toContain("fullDatabaseId");
      calls.push(variables);
      return replies.shift();
    };
    expect(await graphQlThreadReader(graphql).reviewThreads(TARGET)).toEqual([
      { resolved: true, firstCommentId: 3_000_000_011 },
      { resolved: false, firstCommentId: 12 },
      { resolved: true, firstCommentId: undefined },
      { resolved: false, firstCommentId: undefined },
    ]);
    expect(calls).toEqual([
      { owner: "acme", repo: "shop", number: 7, after: null },
      { owner: "acme", repo: "shop", number: 7, after: "cursor-1" },
    ]);
  });

  it("reads who resolved a resolved thread", async () => {
    const graphql: GraphQl = async (query) => {
      expect(query).toContain("resolvedBy { login }");
      return page([
        { ...thread(true, "31"), resolvedBy: { login: "lead" } },
        { ...thread(true, "32"), resolvedBy: null },
        // An open thread's resolver (left from before it was unresolved) isn't kept.
        { ...thread(false, "33"), resolvedBy: { login: "lead" } },
      ]);
    };
    expect(await graphQlThreadReader(graphql).reviewThreads(TARGET)).toEqual([
      { resolved: true, firstCommentId: 31, resolvedBy: "lead" },
      { resolved: true, firstCommentId: 32 },
      { resolved: false, firstCommentId: 33 },
    ]);
  });

  it("uses what came back when some threads fail, and reports the errors", async () => {
    const reported: string[][] = [];
    const reader = graphQlThreadReader(
      async () => ({
        ...page([thread(true, "21"), null, thread(true, "not-a-number")]),
        errors: [{ message: "Something went wrong reading a thread" }],
      }),
      (messages) => reported.push(messages),
    );
    expect(await reader.reviewThreads(TARGET)).toEqual([
      { resolved: true, firstCommentId: 21 },
      { resolved: true, firstCommentId: undefined },
    ]);
    expect(reported).toEqual([["Something went wrong reading a thread"]]);
  });

  it("fails on GraphQL errors and on a missing pull request", async () => {
    const errors = graphQlThreadReader(async () => ({
      data: null,
      errors: [{ message: "Resource not accessible by integration" }],
    }));
    await expect(errors.reviewThreads(TARGET)).rejects.toThrow(
      "Resource not accessible by integration",
    );
    const missing = graphQlThreadReader(async () => ({ data: { repository: null } }));
    await expect(missing.reviewThreads(TARGET)).rejects.toThrow("no such pull request");
  });
});
