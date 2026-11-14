import { syncStatusLabel } from "@lgtmoose/summary";
import { describe, expect, it } from "vitest";
import { annotationsFor } from "./check-run.js";
import { GitHubClient, GitHubError } from "./github.js";
import { GitHubPoster } from "./poster.js";
import { buildReview } from "./review.js";
import { ShadowPoster } from "./shadow.js";
import { fakeFetch, fileDiff, finding } from "./testing/fixtures.js";

const PULL = { owner: "acme", repo: "app", pull: 7 };
const TOKEN = "ghs_secret_installation_token";

function poster(responses: { status: number; body?: unknown }[]) {
  const fake = fakeFetch(responses);
  const github = new GitHubClient({ token: async () => TOKEN, fetch: fake.fetch });
  return { poster: new GitHubPoster(github), github, calls: fake.calls };
}

describe("GitHubClient", () => {
  it("never puts the token in an error", async () => {
    const { github } = poster([{ status: 401, body: { message: `Bad credentials ${TOKEN}` } }]);
    const error = await github.request("GET", "/user").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("keeps GitHub's message readable when the token is empty", async () => {
    const fake = fakeFetch([{ status: 401, body: { message: "Bad credentials" } }]);
    const github = new GitHubClient({ token: async () => "", fetch: fake.fetch });
    await expect(github.request("GET", "/user")).rejects.toThrow("Bad credentials");
  });

  it("sends GraphQL to the API base's GraphQL endpoint, for github.com and Enterprise", async () => {
    for (const [apiUrl, url] of [
      [undefined, "https://api.github.com/graphql"],
      ["https://ghe.example.com/api/v3", "https://ghe.example.com/api/graphql"],
      ["https://ghe.example.com/api/v3/", "https://ghe.example.com/api/graphql"],
    ] as const) {
      const fake = fakeFetch([{ status: 200, body: { data: { ok: true } } }]);
      const github = new GitHubClient({
        token: async () => TOKEN,
        fetch: fake.fetch,
        ...(apiUrl === undefined ? {} : { apiUrl }),
      });
      expect(github.graphqlUrl).toBe(url);
      expect(await github.graphql("query { ok }", { n: 1 })).toEqual({ data: { ok: true } });
      expect(fake.calls[0]).toMatchObject({
        method: "POST",
        url,
        body: { query: "query { ok }", variables: { n: 1 } },
        auth: `Bearer ${TOKEN}`,
      });
    }
  });

  it("follows pages until a short one", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` }));
    const { github, calls } = poster([
      { status: 200, body: page },
      { status: 200, body: [{ name: "last" }] },
    ]);
    expect(await github.list("/repos/acme/app/labels")).toHaveLength(101);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/app/labels?per_page=100&page=1",
      "https://api.github.com/repos/acme/app/labels?per_page=100&page=2",
    ]);
  });
});

describe("GitHubPoster", () => {
  const review = buildReview({
    event: "REQUEST_CHANGES",
    inline: [finding()],
    outsideDiff: [],
    files: [fileDiff()],
    nitCap: 10,
  });

  it("submits one review with its comments", async () => {
    const { poster: p, calls } = poster([{ status: 200, body: { id: 11 } }]);
    const posted = await p.submitReview(PULL, "abc", review);
    expect(posted).toMatchObject({ id: 11, movedToBody: false });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/app/pulls/7/reviews",
      body: { commit_id: "abc", event: "REQUEST_CHANGES", comments: [expect.any(Object)] },
      auth: `Bearer ${TOKEN}`,
    });
  });

  it("reads back each inline comment's ID, matched by place", async () => {
    const [comment] = review.comments;
    if (comment === undefined) throw new Error("expected a comment");
    const { poster: p, calls } = poster([
      { status: 200, body: { id: 11 } },
      {
        status: 200,
        body: [
          { id: 900, path: "other.ts", side: "RIGHT", line: comment.line },
          { id: 901, path: comment.path, side: comment.side, line: comment.line },
        ],
      },
    ]);
    const posted = await p.submitReview(PULL, "abc", review);
    expect(posted.commentIds).toEqual([901]);

    // Outdated already (the PR moved on): no line, only the original one.
    const { poster: o } = poster([
      { status: 200, body: { id: 13 } },
      {
        status: 200,
        body: [
          {
            id: 902,
            path: comment.path,
            side: null,
            line: null,
            original_side: comment.side,
            original_line: comment.line,
          },
        ],
      },
    ]);
    expect((await o.submitReview(PULL, "abc", review)).commentIds).toEqual([902]);
    expect(calls[1]).toMatchObject({
      method: "GET",
      url: "https://api.github.com/repos/acme/app/pulls/7/reviews/11/comments?per_page=100&page=1",
    });

    // The review is posted either way: an ID that can't be read is left out.
    const { poster: q } = poster([{ status: 200, body: { id: 12 } }, { status: 500 }]);
    expect((await q.submitReview(PULL, "abc", review)).commentIds).toEqual([undefined]);
  });

  it("moves comments into the body and retries once when GitHub refuses a position", async () => {
    const { poster: p, calls } = poster([
      { status: 422, body: { message: "Unprocessable Entity" } },
      { status: 200, body: { id: 12 } },
    ]);
    const posted = await p.submitReview(PULL, "abc", review);
    expect(posted).toMatchObject({ id: 12, movedToBody: true });
    const retry = calls[1]?.body as { comments: unknown[]; body: string } | undefined;
    expect(retry?.comments).toEqual([]);
    expect(retry?.body).toContain("src\\/total\\.ts:9");
  });

  it("doesn't retry other errors, or a 422 with no comments to move", async () => {
    const { poster: p } = poster([{ status: 500 }]);
    await expect(p.submitReview(PULL, "abc", review)).rejects.toThrow("HTTP 500");
    const bare = { ...review, comments: [], commented: [] };
    const { poster: q, calls } = poster([{ status: 422 }]);
    await expect(q.submitReview(PULL, "abc", bare)).rejects.toThrow("HTTP 422");
    expect(calls).toHaveLength(1);
  });

  it("completes the check run, sending annotations 50 at a time", async () => {
    const many = Array.from({ length: 120 }, (_, i) => finding({ line: i + 1 }));
    const { poster: p, calls } = poster([
      { status: 200, body: { id: 5 } },
      { status: 200, body: { id: 5 } },
      { status: 200, body: { id: 5 } },
    ]);
    const id = await p.completeCheckRun(PULL, {
      headSha: "abc",
      conclusion: "failure",
      title: "Changes requested",
      summary: "…",
      annotations: annotationsFor(many),
      existingId: 5,
    });
    expect(id).toBe(5);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH https://api.github.com/repos/acme/app/check-runs/5",
      "PATCH https://api.github.com/repos/acme/app/check-runs/5",
      "PATCH https://api.github.com/repos/acme/app/check-runs/5",
    ]);
    const sizes = calls.map(
      (c) => ((c.body as { output: { annotations?: unknown[] } }).output.annotations ?? []).length,
    );
    expect(sizes).toEqual([50, 50, 20]);
    expect(calls[0]?.body).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("creates the check run when there's no earlier one", async () => {
    const { poster: p, calls } = poster([{ status: 201, body: { id: 9 } }]);
    await p.completeCheckRun(PULL, {
      headSha: "abc",
      conclusion: "action_required",
      title: "Review incomplete",
      summary: "ok",
      annotations: [],
      detailsUrl: "https://github.com/acme/app/pull/7#issuecomment-1",
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: {
        name: "LGTMoose",
        head_sha: "abc",
        conclusion: "action_required",
        details_url: "https://github.com/acme/app/pull/7#issuecomment-1",
      },
    });
  });

  it("edits the summary comment in place, or creates it when it's gone", async () => {
    const { poster: p, calls } = poster([
      { status: 200, body: {} },
      { status: 404, body: { message: "Not Found" } },
      { status: 201, body: { id: 99 } },
    ]);
    expect(await p.upsertSummaryComment(PULL, "body", 42)).toEqual({ id: 42, created: false });
    expect(await p.upsertSummaryComment(PULL, "body", 43)).toEqual({ id: 99, created: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH https://api.github.com/repos/acme/app/issues/comments/42",
      "PATCH https://api.github.com/repos/acme/app/issues/comments/43",
      "POST https://api.github.com/repos/acme/app/issues/7/comments",
    ]);
  });

  it("syncs status labels through GitHub, encoding names and never creating labels", async () => {
    const { poster: p, calls } = poster([
      {
        status: 200,
        body: [{ name: "Ready for Review" }, { name: "Requires Changes" }, { name: "Approved" }],
      },
      { status: 200, body: [{ name: "Ready for Review" }, { name: "bug" }] },
      { status: 204 },
      { status: 200, body: [] },
      { status: 200, body: [{ name: "bug" }, { name: "Approved" }] },
    ]);
    const result = await syncStatusLabel(p.labels(PULL), {
      target: "Approved",
      statusLabels: ["Ready for Review", "Requires Changes", "Approved"],
    });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url.replace(/\?.*/, "")}`)).toEqual([
      "GET https://api.github.com/repos/acme/app/labels",
      "GET https://api.github.com/repos/acme/app/issues/7/labels",
      "DELETE https://api.github.com/repos/acme/app/issues/7/labels/Ready%20for%20Review",
      "POST https://api.github.com/repos/acme/app/issues/7/labels",
      "GET https://api.github.com/repos/acme/app/issues/7/labels",
    ]);
  });

  it("treats removing a label that's already gone as done", async () => {
    const { poster: p } = poster([{ status: 404 }]);
    await expect(p.labels(PULL).removePrLabel("x")).resolves.toBeUndefined();
  });
});

describe("annotationsFor", () => {
  it("maps severities and leaves out findings on deleted lines", () => {
    const annotations = annotationsFor([
      finding({ start_line: 8 }),
      finding({ severity: "nit" }),
      finding({ side: "LEFT" }),
    ]);
    expect(annotations).toEqual([
      expect.objectContaining({ start_line: 8, end_line: 9, annotation_level: "failure" }),
      expect.objectContaining({ annotation_level: "notice" }),
    ]);
  });
});

describe("ShadowPoster", () => {
  it("records every call in order and posts nothing", async () => {
    const puts = new Map<string, string>();
    const logs: string[] = [];
    const shadow = new ShadowPoster({
      store: { put: async (key, body) => void puts.set(key, body) },
      runId: "run-1",
      log: (message) => logs.push(message),
      labelReader: {
        listRepoLabels: async () => ["Ready for Review", "Requires Changes", "Approved"],
        listPrLabels: async () => ["Ready for Review"],
      },
    });
    const review = buildReview({
      event: "COMMENT",
      inline: [finding()],
      outsideDiff: [],
      files: [fileDiff()],
      nitCap: 1,
    });
    expect(await shadow.submitReview(PULL, "abc", review)).toMatchObject({ id: undefined });
    expect(await shadow.upsertSummaryComment(PULL, "summary")).toEqual({
      id: undefined,
      created: true,
    });
    const sync = await syncStatusLabel(shadow.labels(PULL), {
      target: "Requires Changes",
      statusLabels: ["Ready for Review", "Requires Changes", "Approved"],
    });
    expect(sync.ok).toBe(true);
    expect([...puts.keys()]).toEqual([
      "shadow/acme/app/7/run-1/001-review.json",
      "shadow/acme/app/7/run-1/002-summary-comment.json",
      "shadow/acme/app/7/run-1/003-labels-remove.json",
      "shadow/acme/app/7/run-1/004-labels-add.json",
    ]);
    expect(JSON.parse(puts.get("shadow/acme/app/7/run-1/001-review.json") ?? "{}")).toMatchObject({
      event: "COMMENT",
      commit_id: "abc",
    });
    expect(logs).toHaveLength(4);
  });
});
