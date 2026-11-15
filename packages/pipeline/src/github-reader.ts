import { z } from "zod";
import type { PullComment, PullReader, PullTarget } from "./pull.js";

/**
 * One authenticated GitHub REST GET, resolving to the JSON body: the CLI's request helper with
 * a local token, or the control task's client with an installation token.
 */
export type GitHubGet = (path: string) => Promise<unknown>;

const SHA = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

const pullSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  author_association: z.string().optional(),
  head: z.object({ sha: SHA, ref: z.string() }),
  base: z.object({
    sha: SHA,
    ref: z.string(),
    repo: z.object({ private: z.boolean() }).nullish(),
  }),
  labels: z.array(z.object({ name: z.string() })).optional(),
});

/** One file from the contents API: base64 for a file, an array for a directory. */
const contentsSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
});

/** Whether a request failed with this HTTP status, from whichever client made it. */
function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === status
  );
}

const issueCommentSchema = z.object({
  id: z.number().int().optional(),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string(), type: z.string().optional() }).nullable(),
  author_association: z.string().optional(),
  performed_via_github_app: z.object({ id: z.number().int() }).nullable().optional(),
  html_url: z.string().optional(),
});

const reviewSchema = z.object({ state: z.string(), commit_id: z.string() });

const reviewCommentSchema = issueCommentSchema.extend({
  path: z.string(),
  line: z.number().int().positive().nullable().optional(),
  start_line: z.number().int().positive().nullable().optional(),
  side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  in_reply_to_id: z.number().int().positive().optional(),
});

/** A bot per GitHub: an App's account (`type: "Bot"`), or a `[bot]` login. */
function authorTypeOf(user: { login: string; type?: string | undefined } | null): "bot" | "human" {
  if (user === null) return "human";
  return user.type === "Bot" || user.login.endsWith("[bot]") ? "bot" : "human";
}

const PAGE_SIZE = 100;

/** Reads PRs and their comments with the REST API, through `get`. */
export function githubPullReader(get: GitHubGet): PullReader {
  const base = (t: PullTarget) =>
    `/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;

  /** Pages through a list endpoint until it runs out or `limit` items are read. */
  async function list<T>(path: string, schema: z.ZodType<T>, limit: number): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; items.length < limit; page += 1) {
      const reply = z
        .array(z.unknown())
        .parse(await get(`${path}?per_page=${PAGE_SIZE}&page=${page}`));
      for (const item of reply) {
        const parsed = schema.safeParse(item);
        if (parsed.success) items.push(parsed.data);
      }
      if (reply.length < PAGE_SIZE) break;
    }
    return items.slice(0, limit);
  }

  return {
    async pull(target) {
      const pr = pullSchema.parse(await get(`${base(target)}/pulls/${target.number}`));
      return {
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user?.login ?? "ghost",
        ...(pr.author_association === undefined ? {} : { association: pr.author_association }),
        ...(pr.base.repo === null || pr.base.repo === undefined
          ? {}
          : { repoPrivate: pr.base.repo.private }),
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        baseSha: pr.base.sha,
        baseRef: pr.base.ref,
        state: pr.state,
        ...(pr.labels === undefined ? {} : { labels: pr.labels.map((label) => label.name) }),
      };
    },
    async fileAt(target, sha, path) {
      if (!SHA.safeParse(sha).success) throw new Error("Not a commit SHA.");
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      let reply: unknown;
      try {
        reply = await get(`${base(target)}/contents/${encoded}?ref=${sha}`);
      } catch (error) {
        if (hasStatus(error, 404)) return undefined;
        throw error;
      }
      const file = contentsSchema.safeParse(reply);
      if (!file.success) return undefined;
      return Buffer.from(file.data.content, "base64").toString("utf8");
    },
    async comments(target, limit) {
      const [general, inline] = await Promise.all([
        list(`${base(target)}/issues/${target.number}/comments`, issueCommentSchema, limit),
        list(`${base(target)}/pulls/${target.number}/comments`, reviewCommentSchema, limit),
      ]);
      const comments: PullComment[] = [
        // General comments carry who wrote them too, for the prompt-injection detector. Without a
        // `path` they're never taken for other reviewers' findings.
        ...general.map((c) => ({
          author: c.user?.login ?? "ghost",
          body: c.body ?? "",
          authorType: authorTypeOf(c.user),
          ...(c.author_association === undefined ? {} : { association: c.author_association }),
          ...(typeof c.performed_via_github_app?.id === "number"
            ? { viaAppId: c.performed_via_github_app.id }
            : {}),
          ...(c.html_url === undefined ? {} : { url: c.html_url }),
        })),
        ...inline.map((c) => ({
          ...(c.id === undefined ? {} : { id: c.id }),
          author: c.user?.login ?? "ghost",
          body: c.body ?? "",
          path: c.path,
          ...(typeof c.line === "number" ? { line: c.line } : {}),
          ...(typeof c.start_line === "number" ? { startLine: c.start_line } : {}),
          ...(typeof c.side === "string" ? { side: c.side } : {}),
          authorType: authorTypeOf(c.user),
          ...(c.author_association === undefined ? {} : { association: c.author_association }),
          ...(c.in_reply_to_id === undefined ? {} : { inReplyTo: c.in_reply_to_id }),
          ...(typeof c.performed_via_github_app?.id === "number"
            ? { viaAppId: c.performed_via_github_app.id }
            : {}),
          ...(c.html_url === undefined ? {} : { url: c.html_url }),
        })),
      ];
      return comments.filter((c) => c.body.trim() !== "");
    },
    async review(target, reviewId) {
      if (!Number.isSafeInteger(reviewId) || reviewId <= 0) throw new Error("Not a review ID.");
      const review = reviewSchema.parse(
        await get(`${base(target)}/pulls/${target.number}/reviews/${reviewId}`),
      );
      return { state: review.state, commitId: review.commit_id };
    },
  };
}
