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

  it("reads the PR's labels as GitHub has them now", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/pulls/7": {
        title: "Fix",
        body: "",
        state: "open",
        user: { login: "dev" },
        head: { sha: SHA_A, ref: "feature" },
        base: { sha: SHA_B, ref: "main" },
        labels: [{ name: "bug" }, { name: "lgtmoose:review" }],
      },
    });
    expect((await githubPullReader(get).pull(target)).labels).toEqual(["bug", "lgtmoose:review"]);
  });

  it("reads a file at a commit, and nothing when there's none", async () => {
    const calls: string[] = [];
    const get: GitHubGet = async (path) => {
      calls.push(path);
      if (path.includes("missing")) throw Object.assign(new Error("Not Found"), { status: 404 });
      if (path.includes("dir")) return [{ name: "a" }];
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from("review:\n  trigger: label\n").toString("base64"),
      };
    };
    const reader = githubPullReader(get);
    expect(await reader.fileAt?.(target, SHA_B, ".lgtmoose.yaml")).toBe(
      "review:\n  trigger: label\n",
    );
    expect(calls).toEqual([`/repos/acme/shop/contents/.lgtmoose.yaml?ref=${SHA_B}`]);
    expect(await reader.fileAt?.(target, SHA_B, "missing.yaml")).toBeUndefined();
    expect(await reader.fileAt?.(target, SHA_B, "dir")).toBeUndefined();
    await expect(reader.fileAt?.(target, "main", ".lgtmoose.yaml")).rejects.toThrow(/SHA/);
    // Any other failure is the run's to retry, not a missing config.
    const failing = githubPullReader(async () => {
      throw Object.assign(new Error("Server Error"), { status: 500 });
    });
    await expect(failing.fileAt?.(target, SHA_B, ".lgtmoose.yaml")).rejects.toThrow("Server");
  });

  it("keeps the author's relationship to the repository", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/pulls/7": {
        title: "Fix",
        body: "",
        state: "open",
        user: { login: "dev" },
        author_association: "CONTRIBUTOR",
        head: { sha: SHA_A, ref: "feature" },
        base: { sha: SHA_B, ref: "main" },
      },
    });
    const pull = await githubPullReader(get).pull(target);
    expect(pull).toMatchObject({ author: "dev", association: "CONTRIBUTOR" });
    // No repository in the payload: visibility unknown.
    expect(pull.repoPrivate).toBeUndefined();
  });

  it("keeps whether the repository is private", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/pulls/7": {
        title: "Fix",
        body: "",
        state: "open",
        user: { login: "dev" },
        head: { sha: SHA_A, ref: "feature" },
        base: { sha: SHA_B, ref: "main", repo: { private: true } },
      },
    });
    expect((await githubPullReader(get).pull(target)).repoPrivate).toBe(true);
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
      { author: "a", body: "Looks good", authorType: "human" },
      {
        author: "ghost",
        body: "Off by one",
        path: "src/a.ts",
        line: 3,
        side: "RIGHT",
        authorType: "human",
      },
      { author: "c", body: "Outdated", path: "src/a.ts", authorType: "human" },
    ]);
  });

  it("keeps who wrote a general comment, for the prompt-injection detector", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/issues/7/comments?per_page=100&page=1": [
        {
          body: "Thanks!",
          user: { login: "lgtmoose[bot]", type: "Bot" },
          author_association: "NONE",
          performed_via_github_app: { id: 7 },
          html_url: "https://github.com/acme/shop/pull/7#issuecomment-1",
        },
        { body: "Nice", user: { login: "dev" }, author_association: "MEMBER" },
      ],
      "/repos/acme/shop/pulls/7/comments?per_page=100&page=1": [],
    });
    expect(await githubPullReader(get).comments(target, 50)).toEqual([
      {
        author: "lgtmoose[bot]",
        body: "Thanks!",
        authorType: "bot",
        association: "NONE",
        viaAppId: 7,
        url: "https://github.com/acme/shop/pull/7#issuecomment-1",
      },
      { author: "dev", body: "Nice", authorType: "human", association: "MEMBER" },
    ]);
  });

  it("keeps who wrote a diff comment, its thread and its link", async () => {
    const { get } = fakeGet({
      "/repos/acme/shop/issues/7/comments?per_page=100&page=1": [],
      "/repos/acme/shop/pulls/7/comments?per_page=100&page=1": [
        {
          id: 5,
          body: "_🔴 Critical_",
          user: { login: "coderabbitai[bot]", type: "Bot" },
          path: "src/a.ts",
          line: 4,
          author_association: "NONE",
          performed_via_github_app: { id: 347564 },
          html_url: "https://github.com/acme/shop/pull/7#discussion_r5",
        },
        {
          id: 6,
          body: "Agreed",
          user: { login: "alice", type: "User" },
          path: "src/a.ts",
          line: 4,
          author_association: "MEMBER",
          in_reply_to_id: 5,
          performed_via_github_app: null,
        },
      ],
    });
    expect(await githubPullReader(get).comments(target, 50)).toEqual([
      {
        id: 5,
        author: "coderabbitai[bot]",
        body: "_🔴 Critical_",
        path: "src/a.ts",
        line: 4,
        authorType: "bot",
        association: "NONE",
        viaAppId: 347564,
        url: "https://github.com/acme/shop/pull/7#discussion_r5",
      },
      {
        id: 6,
        author: "alice",
        body: "Agreed",
        path: "src/a.ts",
        line: 4,
        authorType: "human",
        association: "MEMBER",
        inReplyTo: 5,
      },
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

  describe("CI (NIC-1078)", () => {
    const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

    it("reads the head's latest check runs and commit statuses", async () => {
      const { get, calls } = fakeGet({
        [`/repos/acme/shop/commits/${SHA_A}/check-runs?filter=latest&per_page=100&page=1`]: {
          check_runs: [
            { name: "build", status: "completed", conclusion: "success" },
            { name: "test", status: "in_progress", conclusion: null },
          ],
        },
        [`/repos/acme/shop/commits/${SHA_A}/status?per_page=100`]: {
          state: "pending",
          statuses: [{ context: "ci/legacy", state: "pending" }],
        },
      });
      expect(await githubPullReader(get).checksAt?.(target, SHA_A)).toEqual({
        runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "test", status: "in_progress", conclusion: undefined },
        ],
        statuses: [{ context: "ci/legacy", state: "pending" }],
      });
      expect(calls).toHaveLength(2);
      await expect(githubPullReader(get).checksAt?.(target, "main")).rejects.toThrow(/SHA/);
    });

    it("counts only check runs when the App can't read commit statuses yet", async () => {
      const reader = githubPullReader(async (path) => {
        if (path.includes("/status")) throw withStatus(403);
        return { check_runs: [] };
      });
      expect(await reader.checksAt?.(target, SHA_A)).toEqual({ runs: [], statuses: [] });
      const broken = githubPullReader(async (path) => {
        if (path.includes("/status")) throw withStatus(500);
        return { check_runs: [] };
      });
      await expect(broken.checksAt?.(target, SHA_A)).rejects.toThrow("500");
    });

    it("reads the required checks from rulesets and classic protection, without administration", async () => {
      const { get, calls } = fakeGet({
        "/repos/acme/shop/rules/branches/release/1.x?per_page=100": [
          { type: "pull_request", parameters: {} },
          {
            type: "required_status_checks",
            parameters: { required_status_checks: [{ context: "build" }, { context: "test" }] },
          },
        ],
        "/repos/acme/shop/branches/release/1.x": {
          protection: {
            required_status_checks: { contexts: ["test", "legacy"], checks: [{ context: "lint" }] },
          },
        },
      });
      expect(await githubPullReader(get).requiredChecks?.(target, "release/1.x")).toEqual([
        "build",
        "test",
        "legacy",
        "lint",
      ]);
      expect(calls).toHaveLength(2);
      // Neither found: nothing required.
      const none = githubPullReader(async () => {
        throw withStatus(404);
      });
      expect(await none.requiredChecks?.(target, "main")).toEqual([]);
    });
  });
});
