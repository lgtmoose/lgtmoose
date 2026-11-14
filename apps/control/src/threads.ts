import type { PullTarget } from "@lgtmoose/pipeline";
import { z } from "zod";

/** One review thread on a PR: whether it's resolved, and its first comment's ID. */
export interface ReviewThread {
  resolved: boolean;
  /**
   * The REST ID of the thread's first comment (GraphQL's `fullDatabaseId`: review-comment IDs
   * are past 2^31, too big for `databaseId`); undefined if it was deleted.
   */
  firstCommentId: number | undefined;
  /** Who resolved it, for a resolved thread; undefined when GitHub doesn't say (a ghost). */
  resolvedBy?: string;
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
        nodes { isResolved resolvedBy { login } comments(first: 1) { nodes { fullDatabaseId } } }
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
                      resolvedBy: z.object({ login: z.string() }).nullable().optional(),
                      comments: z.object({
                        nodes: z.array(
                          z
                            .object({
                              // A BigInt, sent as a string (a number from some servers).
                              fullDatabaseId: z.union([z.string(), z.number()]).nullable(),
                            })
                            .nullable(),
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

/**
 * A comment ID from `fullDatabaseId`: a whole number within JavaScript's exact range (2^53;
 * GitHub's IDs are in the billions), else undefined. `github_comment_id` is a Postgres bigint.
 */
function commentId(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Most pages read: 100 threads each. A PR with more is unusual; the rest are left alone. */
const MAX_PAGES = 20;

/**
 * Reads review threads through GitHub GraphQL, 100 at a time. A reply with errors but data
 * (some threads unreadable) is used as far as it goes: the failed nodes come back null and are
 * skipped, and the errors go to `onErrors`. Only a reply with no threads at all fails.
 */
export function graphQlThreadReader(
  graphql: GraphQl,
  onErrors: (messages: string[]) => void = () => {},
): ReviewThreadReader {
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
        const errors = (reply.errors ?? []).map((error) => error.message);
        const list = reply.data?.repository?.pullRequest?.reviewThreads;
        if (list === undefined) {
          throw new Error(
            errors.length > 0
              ? `GitHub GraphQL: ${errors.join("; ")}`
              : "GitHub GraphQL: no such pull request.",
          );
        }
        if (errors.length > 0) onErrors(errors);
        for (const node of list.nodes) {
          if (node === null) continue;
          const resolvedBy = node.resolvedBy?.login;
          threads.push({
            resolved: node.isResolved,
            firstCommentId: commentId(node.comments.nodes[0]?.fullDatabaseId),
            ...(node.isResolved && resolvedBy !== undefined ? { resolvedBy } : {}),
          });
        }
        if (!list.pageInfo.hasNextPage || list.pageInfo.endCursor === null) break;
        after = list.pageInfo.endCursor;
      }
      return threads;
    },
  };
}
