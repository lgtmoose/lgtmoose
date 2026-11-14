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

const thread = (isResolved: boolean, databaseId: number | null) => ({
  isResolved,
  comments: { nodes: databaseId === undefined ? [] : [{ databaseId }] },
});

describe("graphQlThreadReader", () => {
  it("reads every page of the PR's threads, with each first comment's ID", async () => {
    const calls: Record<string, unknown>[] = [];
    const replies = [
      page([thread(true, 11), thread(false, 12)], "cursor-1"),
      page([thread(true, null), { isResolved: false, comments: { nodes: [] } }, null]),
    ];
    const graphql: GraphQl = async (query, variables) => {
      expect(query).toContain("reviewThreads");
      calls.push(variables);
      return replies.shift();
    };
    expect(await graphQlThreadReader(graphql).reviewThreads(TARGET)).toEqual([
      { resolved: true, firstCommentId: 11 },
      { resolved: false, firstCommentId: 12 },
      { resolved: true, firstCommentId: undefined },
      { resolved: false, firstCommentId: undefined },
    ]);
    expect(calls).toEqual([
      { owner: "acme", repo: "shop", number: 7, after: null },
      { owner: "acme", repo: "shop", number: 7, after: "cursor-1" },
    ]);
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
