import type { PullTarget } from "@lgtmoose/pipeline";
import { z } from "zod";

/** One review thread on a PR: whether it's resolved, and its first comment's ID. */
export interface ReviewThread {
  resolved: boolean;
  /** The REST ID (`databaseId`) of the thread's first comment; undefined if it was deleted. */
  firstCommentId: number | undefined;
}

/** Reads a PR's review threads. GraphQL only: REST doesn't say whether a thread is resolved. */
export interface ReviewThreadReader {
  reviewThreads(target: PullTarget): Promise<ReviewThread[]>;
}

/** One authenticated GitHub GraphQL request, resolving to the JSON body (`data` and `errors`). */
export type GraphQl = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

const QUERY = `query ($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

const replySchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              reviewThreads: z.object({
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
                nodes: z.array(
                  z
                    .object({
                      isResolved: z.boolean(),
                      comments: z.object({
                        nodes: z.array(
                          z.object({ databaseId: z.number().int().nullable() }).nullable(),
                        ),
                      }),
                    })
                    .nullable(),
                ),
              }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** Most pages read: 100 threads each. A PR with more is unusual; the rest are left alone. */
const MAX_PAGES = 20;

/** Reads review threads through GitHub GraphQL, 100 at a time. */
export function graphQlThreadReader(graphql: GraphQl): ReviewThreadReader {
  return {
    async reviewThreads(target) {
      const threads: ReviewThread[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const reply = replySchema.parse(
          await graphql(QUERY, {
            owner: target.owner,
            repo: target.repo,
            number: target.number,
            after,
          }),
        );
        if (reply.errors !== undefined && reply.errors.length > 0) {
          throw new Error(
            `GitHub GraphQL: ${reply.errors.map((error) => error.message).join("; ")}`,
          );
        }
        const list = reply.data?.repository?.pullRequest?.reviewThreads;
        if (list === undefined) throw new Error("GitHub GraphQL: no such pull request.");
        for (const node of list.nodes) {
          if (node === null) continue;
          const id = node.comments.nodes[0]?.databaseId ?? undefined;
          threads.push({ resolved: node.isResolved, firstCommentId: id });
        }
        if (!list.pageInfo.hasNextPage || list.pageInfo.endCursor === null) break;
        after = list.pageInfo.endCursor;
      }
      return threads;
    },
  };
}
