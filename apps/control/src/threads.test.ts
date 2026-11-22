import { describe, expect, it } from "vitest";
import { GraphQlError, graphQlThreadReader, resolveReviewThread, type GraphQl } from "./threads.js";

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
    const threads = await graphQlThreadReader(graphql).reviewThreads(TARGET);
    expect([...threads]).toEqual([
      { resolved: true, firstCommentId: 3_000_000_011 },
      { resolved: false, firstCommentId: 12 },
      { resolved: true, firstCommentId: undefined },
      { resolved: false, firstCommentId: undefined },
    ]);
    // A thread GitHub left out (null), and threads without IDs: not the whole list.
    expect(threads.partial).toBe(true);
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
    expect([...(await graphQlThreadReader(graphql).reviewThreads(TARGET))]).toEqual([
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
    const threads = await reader.reviewThreads(TARGET);
    expect([...threads]).toEqual([
      { resolved: true, firstCommentId: 21 },
      { resolved: true, firstCommentId: undefined },
    ]);
    expect(threads.partial).toBe(true);
    expect(reported).toEqual([["Something went wrong reading a thread"]]);
  });

  it("says the list is whole only when every page was read and every thread has its ID", async () => {
    const node = (id: string, comment: string) => ({ ...thread(false, comment), id });
    const whole = await graphQlThreadReader(async () =>
      page([node("PRRT_1", "1"), node("PRRT_2", "2")]),
    ).reviewThreads(TARGET);
    expect(whole.partial).toBeUndefined();
    expect(whole.map((entry) => entry.id)).toEqual(["PRRT_1", "PRRT_2"]);

    // Every page says there's another: the reader stops at its limit, short of the end.
    let n = 0;
    const endless = await graphQlThreadReader(async () => {
      n += 1;
      return page([node(`PRRT_${n}`, String(n))], `cursor-${n}`);
    }).reviewThreads(TARGET);
    expect(endless.length).toBe(20);
    expect(endless.partial).toBe(true);
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

describe("resolveReviewThread", () => {
  const failing =
    (errors: unknown[]): GraphQl =>
    async () => ({ data: null, errors });

  it("resolves when GitHub answers without errors", async () => {
    await expect(
      resolveReviewThread(async () => ({ data: { resolveReviewThread: {} } }), "PRRT_1"),
    ).resolves.toBeUndefined();
  });

  it("throws a permanent error for a deleted thread or a forbidden one", async () => {
    for (const errors of [
      [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'x'" }],
      [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
      [{ type: "UNPROCESSABLE", message: "Thread is locked" }],
      [{ message: "Resource not accessible by integration" }],
    ]) {
      const error: unknown = await resolveReviewThread(failing(errors), "PRRT_1").catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(GraphQlError);
      expect((error as GraphQlError).permanent).toBe(true);
    }
  });

  it("throws a transient error for anything else", async () => {
    const error: unknown = await resolveReviewThread(
      failing([{ type: "INTERNAL", message: "Something went wrong" }]),
      "PRRT_1",
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GraphQlError);
    expect((error as GraphQlError).permanent).toBe(false);
  });
});
