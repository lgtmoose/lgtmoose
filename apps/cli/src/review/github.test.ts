import { describe, expect, it } from "vitest";
import { githubPullReader } from "./github.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function fakeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchFn = (async (input: string, init?: RequestInit) => {
    const url = input;
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    const path = url.replace("https://api.test", "");
    if (!(path in routes))
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const target = { owner: "acme", repo: "shop", number: 7 };

describe("githubPullReader", () => {
  it("reads the PR with the token", async () => {
    const { fetchFn, calls } = fakeFetch({
      "/repos/acme/shop/pulls/7": {
        title: "Fix",
        body: null,
        state: "open",
        user: { login: "dev" },
        head: { sha: SHA_A, ref: "feature" },
        base: { sha: SHA_B, ref: "main" },
      },
    });
    const pr = await githubPullReader(fetchFn, "https://api.test", "tok").pull(target);
    expect(pr).toEqual({
      title: "Fix",
      body: "",
      author: "dev",
      headSha: SHA_A,
      headRef: "feature",
      baseSha: SHA_B,
      baseRef: "main",
      state: "open",
    });
    expect(calls[0]?.auth).toBe("Bearer tok");
  });

  it("reads both kinds of comments, skipping empty and malformed ones", async () => {
    const { fetchFn } = fakeFetch({
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
    const comments = await githubPullReader(fetchFn, "https://api.test", "t").comments(target, 50);
    expect(comments).toEqual([
      { author: "a", body: "Looks good" },
      { author: "ghost", body: "Off by one", path: "src/a.ts", line: 3, side: "RIGHT" },
      { author: "c", body: "Outdated", path: "src/a.ts" },
    ]);
  });

  it("pages until a short page and stops at the limit", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ body: `c${i}`, user: { login: "u" } }));
    const { fetchFn, calls } = fakeFetch({
      "/repos/acme/shop/issues/7/comments?per_page=100&page=1": page(100),
      "/repos/acme/shop/issues/7/comments?per_page=100&page=2": page(100),
      "/repos/acme/shop/pulls/7/comments?per_page=100&page=1": [],
    });
    const comments = await githubPullReader(fetchFn, "https://api.test", "t").comments(target, 150);
    expect(comments).toHaveLength(150);
    expect(calls.filter((c) => c.url.includes("issues"))).toHaveLength(2);
  });
});
