import { GitHubError, type GitHubClient } from "@lgtmoose/poster";
import { z } from "zod";
import type { BootstrapGitHub, HistoryComment } from "./bootstrap.js";
import { collaboratorPermission } from "./github-access.js";

/** GitHub's REST API as a bootstrap reads it (NIC-1080), with an installation token. */

type Log = (message: string, fields?: Record<string, unknown>) => void;

const PAGE = 100;
/** Pages of closed PRs looked through for merged ones: 3,000 PRs at most. */
const MAX_PAGES = 30;
/** A hint file larger than this isn't read. */
const MAX_FILE_BYTES = 200_000;

const user = z.object({ login: z.string(), type: z.string().optional() }).nullable();
const pullSchema = z.object({
  number: z.number().int().positive(),
  merged_at: z.string().nullable(),
});
const reviewCommentSchema = z.object({
  id: z.number().int().positive(),
  user,
  body: z.string().nullable().optional(),
  html_url: z.string(),
  path: z.string().optional(),
});
const reviewSchema = z.object({
  id: z.number().int().positive(),
  user,
  body: z.string().nullable().optional(),
  html_url: z.string(),
});
const contentSchema = z.object({
  type: z.string(),
  encoding: z.string().optional(),
  content: z.string().optional(),
  size: z.number().optional(),
});

function split(repo: string): { owner: string; repo: string; path: string } {
  const [owner = "", name = ""] = repo.split("/");
  return {
    owner,
    repo: name,
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  };
}

const isBot = (account: z.infer<typeof user>) =>
  account === null || account.type === "Bot" || account.login.endsWith("[bot]");

export function githubBootstrap(
  client: Pick<GitHubClient, "request" | "list">,
  log: Log,
): BootstrapGitHub {
  return {
    async mergedPulls(repo, { before, limit }) {
      const { path } = split(repo);
      const merged: number[] = [];
      for (let page = 1; page <= MAX_PAGES && merged.length < limit; page += 1) {
        const reply = z
          .array(pullSchema)
          .parse(
            await client.request(
              "GET",
              `${path}/pulls?state=closed&sort=created&direction=desc&per_page=${PAGE}&page=${page}`,
            ),
          );
        for (const pull of reply) {
          if (pull.merged_at === null) continue;
          if (before !== undefined && pull.number >= before) continue;
          merged.push(pull.number);
          if (merged.length >= limit) break;
        }
        if (reply.length < PAGE) break;
      }
      return merged;
    },
    async comments(repo, pr) {
      const { path } = split(repo);
      const inline = z
        .array(reviewCommentSchema)
        .parse(await client.list(`${path}/pulls/${pr}/comments`));
      const reviews = z.array(reviewSchema).parse(await client.list(`${path}/pulls/${pr}/reviews`));
      const comments: HistoryComment[] = [];
      for (const comment of inline) {
        if (comment.body === undefined || comment.body === null || comment.body.trim() === "")
          continue;
        comments.push({
          id: comment.id,
          pr,
          author: comment.user?.login ?? "",
          authorIsBot: isBot(comment.user),
          body: comment.body,
          url: comment.html_url,
          ...(comment.path === undefined ? {} : { path: comment.path }),
        });
      }
      for (const review of reviews) {
        if (review.body === undefined || review.body === null || review.body.trim() === "")
          continue;
        comments.push({
          id: review.id,
          pr,
          author: review.user?.login ?? "",
          authorIsBot: isBot(review.user),
          body: review.body,
          url: review.html_url,
        });
      }
      return comments;
    },
    permission: (repo, login) => {
      const target = split(repo);
      return collaboratorPermission(client, { owner: target.owner, repo: target.repo }, login, log);
    },
    async file(repo, file) {
      const { path } = split(repo);
      const encoded = file.split("/").map(encodeURIComponent).join("/");
      try {
        const reply = contentSchema.parse(
          await client.request("GET", `${path}/contents/${encoded}`),
        );
        if (reply.type !== "file" || reply.encoding !== "base64" || reply.content === undefined) {
          return undefined;
        }
        if ((reply.size ?? 0) > MAX_FILE_BYTES) return undefined;
        return Buffer.from(reply.content, "base64").toString("utf8");
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return undefined;
        throw error;
      }
    },
  };
}
