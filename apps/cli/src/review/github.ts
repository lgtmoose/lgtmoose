import { z } from "zod";
import { githubRequest } from "../github-request.js";
import type { PullComment, PullReader, PullTarget } from "@lgtmoose/pipeline";

const SHA = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

const pullSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ sha: SHA, ref: z.string() }),
  base: z.object({ sha: SHA, ref: z.string() }),
});

const issueCommentSchema = z.object({
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable(),
});

const reviewCommentSchema = issueCommentSchema.extend({
  path: z.string(),
  line: z.number().int().positive().nullable().optional(),
  start_line: z.number().int().positive().nullable().optional(),
  side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
});

const PAGE_SIZE = 100;

/** Reads PRs with the REST API and a token (from GITHUB_TOKEN, GH_TOKEN or `gh auth token`). */
export function githubPullReader(fetchFn: typeof fetch, apiUrl: string, token: string): PullReader {
  const get = (path: string) => githubRequest(fetchFn, apiUrl, "GET", path, { jwt: token });
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
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        baseSha: pr.base.sha,
        baseRef: pr.base.ref,
        state: pr.state,
      };
    },
    async comments(target, limit) {
      const [general, inline] = await Promise.all([
        list(`${base(target)}/issues/${target.number}/comments`, issueCommentSchema, limit),
        list(`${base(target)}/pulls/${target.number}/comments`, reviewCommentSchema, limit),
      ]);
      const comments: PullComment[] = [
        ...general.map((c) => ({ author: c.user?.login ?? "ghost", body: c.body ?? "" })),
        ...inline.map((c) => ({
          author: c.user?.login ?? "ghost",
          body: c.body ?? "",
          path: c.path,
          ...(typeof c.line === "number" ? { line: c.line } : {}),
          ...(typeof c.start_line === "number" ? { startLine: c.start_line } : {}),
          ...(typeof c.side === "string" ? { side: c.side } : {}),
        })),
      ];
      return comments.filter((c) => c.body.trim() !== "");
    },
  };
}
