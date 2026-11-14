import { describe, expect, it } from "vitest";
import { githubPullReader, type GitHubGet } from "./github-reader.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function fakeGet(routes: Record<string, unknown>): { get: GitHubGet; calls: string[] } {
  const calls: string[] = [];
  const get: GitHubGet = async (path) => {
    calls.push(path);
    if (!(path in routes)) throw new Error(`HTTP 404 ${path}`);
    return routes[path];
  };
  return { get, calls };
}

const target = { owner: "acme", repo: "shop", number: 7 };

describe("githubPullReader", () => {
  it("reads the PR", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/pulls/7": {
        title: "Fix",
        body: null,
        state: "open",
        user: { login: "dev" },
        head: { sha: SHA_A, ref: "feature" },
        base: { sha: SHA_B, ref: "main" },
      },
    });
    expect(await githubPullReader(get).pull(target)).toEqual({
      title: "Fix",
      body: "",
      author: "dev",
      headSha: SHA_A,
      headRef: "feature",
      baseSha: SHA_B,
      baseRef: "main",
      state: "open",
    });
  });

  it("encodes the owner and repo in the path", async () => {
    const { get, calls } = fakeGet({});
    await githubPullReader(get)
      .pull({ owner: "a/b", repo: "c?d", number: 1 })
      .catch(() => undefined);
    expect(calls).toEqual(["/repos/a%2Fb/c%3Fd/pulls/1"]);
  });

  it("reads both kinds of comments, skipping empty and malformed ones", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/issues/7/comments?per_page=100&page=1": [
        { body: "Looks good", user: { login: "a" } },
        { body: "", user: { login: "b" } },
        { nonsense: true },
      ],
      "/repos/acme/shop/pulls/7/comments?per_page=100&page=1": [
        {
          body: "Off by one",
          user: null,
          path: "src/a.ts",
          line: 3,
          start_line: null,
          side: "RIGHT",
        },
        { body: "Outdated", user: { login: "c" }, path: "src/a.ts", line: null },
      ],
    });
    expect(await githubPullReader(get).comments(target, 50)).toEqual([
      { author: "a", body: "Looks good" },
      { author: "ghost", body: "Off by one", path: "src/a.ts", line: 3, side: "RIGHT" },
      { author: "c", body: "Outdated", path: "src/a.ts" },
    ]);
  });

  it("pages until a short page and stops at the limit", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ body: `c${i}`, user: { login: "u" } }));
    const { get, calls } = fakeGet({
      "/repos/acme/shop/issues/7/comments?per_page=100&page=1": page(100),
      "/repos/acme/shop/issues/7/comments?per_page=100&page=2": page(100),
      "/repos/acme/shop/pulls/7/comments?per_page=100&page=1": [],
    });
    expect(await githubPullReader(get).comments(target, 150)).toHaveLength(150);
    expect(calls.filter((path) => path.includes("issues"))).toHaveLength(2);
  });

  it("reads one review's state and commit, and refuses an ID that isn't one", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/pulls/7/reviews/55": { state: "DISMISSED", commit_id: SHA_A },
    });
    const reader = githubPullReader(get);
    expect(await reader.review?.(target, 55)).toEqual({ state: "DISMISSED", commitId: SHA_A });
    await expect(reader.review?.(target, -1)).rejects.toThrow("Not a review ID");
  });
});
