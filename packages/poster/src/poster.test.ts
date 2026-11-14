import { syncStatusLabel } from "@lgtmoose/summary";
import { describe, expect, it } from "vitest";
import { annotationsFor } from "./check-run.js";
import { MAX_MARKER_LENGTH, SUMMARY_MARKER_ROOM } from "@lgtmoose/summary";
import { GitHubClient, GitHubError } from "./github.js";
import { GitHubPoster } from "./poster.js";
import { buildReview, reviewMarkerComment } from "./review.js";
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

  it("gives up on a request that takes longer than its timeout", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const github = new GitHubClient({ token: async () => TOKEN, fetch: hang, timeoutMs: 20 });
    await expect(github.request("POST", "/x", {})).rejects.toThrow();
  });

  it("throws on a 2xx whose body isn't JSON, rather than give back nothing", async () => {
    const empty: typeof fetch = async () => new Response("", { status: 201 });
    const github = new GitHubClient({ token: async () => TOKEN, fetch: empty });
    await expect(github.request("POST", "/x", {})).rejects.toThrow("without a JSON body");
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

  it("reuses the check run with its external ID, else creates it with one", async () => {
    const input = {
      headSha: "abc",
      conclusion: "success" as const,
      title: "No changes needed",
      summary: "ok",
      annotations: [],
      externalId: "run-1",
    };
    const found = poster([
      {
        status: 200,
        body: {
          check_runs: [
            { id: 3, external_id: "other" },
            { id: 4, external_id: "run-1" },
          ],
        },
      },
    ]);
    expect(await found.poster.completeCheckRun(PULL, input)).toBe(4);
    expect(found.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/app/commits/abc/check-runs?check_name=LGTMoose&filter=all&per_page=100&page=1",
    ]);
    const created = poster([
      { status: 200, body: { check_runs: [] } },
      { status: 201, body: { id: 9 } },
    ]);
    expect(await created.poster.completeCheckRun(PULL, input)).toBe(9);
    expect(created.calls[1]).toMatchObject({ method: "POST", body: { external_id: "run-1" } });
  });

  it("sends the annotation pages an earlier attempt didn't get to", async () => {
    const annotations = Array.from({ length: 120 }, (_, i) => ({
      path: "a.ts",
      start_line: i + 1,
      end_line: i + 1,
      annotation_level: "warning" as const,
      title: "t",
      message: `m${i}`,
    }));
    const { poster: p, calls } = poster([
      // The earlier attempt created the run with its first page, then died.
      {
        status: 200,
        body: { check_runs: [{ id: 4, external_id: "run-1", output: { annotations_count: 50 } }] },
      },
      { status: 200, body: { id: 4 } },
      { status: 200, body: { id: 4 } },
    ]);
    await p.completeCheckRun(PULL, {
      headSha: "abc",
      conclusion: "neutral",
      title: "t",
      summary: "s",
      annotations,
      externalId: "run-1",
    });
    const sent = calls.slice(1).map((c) => {
      const output = (c.body as { output: { annotations: { message: string }[] } }).output;
      return [c.method, output.annotations[0]?.message, output.annotations.length];
    });
    expect(sent).toEqual([
      ["PATCH", "m50", 50],
      ["PATCH", "m100", 20],
    ]);
  });

  it("finds the summary comment by its marker when there's no stored ID", async () => {
    const { poster: p, calls } = poster([
      {
        status: 200,
        body: [
          { id: 5, body: "someone else" },
          // Someone quoting the marker: not ours, so never edited.
          { id: 8, body: "> <!-- lgtmoose-summary -->", user: { type: "User" } },
          { id: 6, body: "x\n\n<!-- lgtmoose-summary -->", user: { type: "Bot" } },
        ],
      },
      { status: 200, body: { id: 6 } },
      { status: 200, body: [] },
      { status: 201, body: { id: 7 } },
    ]);
    expect(await p.upsertSummaryComment(PULL, "body", undefined, "lgtmoose-summary")).toEqual({
      id: 6,
      created: false,
    });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://api.github.com/repos/acme/app/issues/comments/6",
      body: { body: "body\n\n<!-- lgtmoose-summary -->" },
    });
    expect(await p.upsertSummaryComment(PULL, "body", undefined, "lgtmoose-summary")).toEqual({
      id: 7,
      created: true,
    });
  });

  it("matches only the App's own comment when it knows the App's ID", async () => {
    const fake = fakeFetch([
      {
        status: 200,
        body: [
          {
            id: 5,
            body: "<!-- lgtmoose-summary -->",
            user: { type: "Bot" },
            performed_via_github_app: { id: 1 },
          },
          {
            id: 6,
            body: "<!-- lgtmoose-summary -->",
            user: { type: "Bot" },
            performed_via_github_app: { id: 42 },
          },
        ],
      },
      { status: 200, body: { id: 6 } },
    ]);
    const github = new GitHubClient({ token: async () => TOKEN, fetch: fake.fetch });
    const p = new GitHubPoster(github, { appId: 42 });
    expect(await p.upsertSummaryComment(PULL, "b", undefined, "lgtmoose-summary")).toEqual({
      id: 6,
      created: false,
    });
  });

  it("creates a new summary comment when editing the old one is refused", async () => {
    const { poster: p, calls } = poster([
      { status: 403, body: { message: "Forbidden" } },
      { status: 201, body: { id: 9 } },
    ]);
    expect(await p.upsertSummaryComment(PULL, "b", 5, "lgtmoose-summary")).toEqual({
      id: 9,
      created: true,
    });
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
  });

  it("rethrows a 403 that's a rate limit instead of creating a second comment", async () => {
    for (const reply of [
      { message: "You have exceeded a secondary rate limit." },
      { message: "API rate limit exceeded for installation." },
    ]) {
      const { poster: p, calls } = poster([{ status: 403, body: reply }]);
      await expect(p.upsertSummaryComment(PULL, "b", 5, "lgtmoose-summary")).rejects.toThrow(
        "HTTP 403",
      );
      expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    }
    const limited: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "Forbidden" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      });
    const github = new GitHubClient({ token: async () => TOKEN, fetch: limited });
    const error = await github.request("PATCH", "/x", {}).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, rateLimited: true });
  });

  it("finds a review of ours on a commit, from any run, matching the App's bot user", async () => {
    const ours = { login: "lgtmoose[bot]", type: "Bot" };
    const reviews = [
      {
        commit_id: "c1",
        body: "<!-- lgtmoose-run:r1 -->",
        user: { login: "other[bot]", type: "Bot" },
      },
      { commit_id: "c2", body: "> <!-- lgtmoose-run:r2 -->", user: { login: "dev", type: "User" } },
      { commit_id: "c3", body: "x\n\n<!-- lgtmoose-run:r3 -->", user: ours },
      { commit_id: "c4", body: "no marker", user: ours },
    ];
    const fake = fakeFetch(Array.from({ length: 5 }, () => ({ status: 200, body: reviews })));
    const github = new GitHubClient({ token: async () => TOKEN, fetch: fake.fetch });
    const p = new GitHubPoster(github, { appSlug: async () => "lgtmoose" });
    expect(await p.markersAt(PULL, "c1", "lgtmoose-run:")).toEqual([]);
    expect(await p.markersAt(PULL, "c2", "lgtmoose-run:")).toEqual([]);
    expect(await p.markersAt(PULL, "c3", "lgtmoose-run:")).toEqual(["lgtmoose-run:r3"]);
    expect(await p.markersAt(PULL, "c4", "lgtmoose-run:")).toEqual([]);
    expect(await p.markersAt(PULL, "c9", "lgtmoose-run:")).toEqual([]);
  });

  it("leaves room in the summary for the longest marker", async () => {
    const longest = "m".repeat(MAX_MARKER_LENGTH);
    const { poster: p, calls } = poster([{ status: 200, body: { id: 1 } }]);
    await p.upsertSummaryComment(PULL, "x".repeat(65_536 - SUMMARY_MARKER_ROOM), 1, longest);
    const body = (calls[0]?.body as { body: string } | undefined)?.body ?? "";
    expect(body.length).toBe(65_536);
    expect(() => reviewMarkerComment(`${longest}m`)).toThrow();
  });

  it("fits the summary comment's marker in the room the summary leaves", async () => {
    const { poster: p, calls } = poster([{ status: 200, body: { id: 1 } }]);
    await p.upsertSummaryComment(PULL, "x".repeat(65_536 - 100), 1, "lgtmoose-summary");
    const body = (calls[0]?.body as { body: string } | undefined)?.body ?? "";
    expect(body.endsWith("<!-- lgtmoose-summary -->")).toBe(true);
    // A body with no room for it is a caller's bug, not something to cut silently.
    await expect(
      p.upsertSummaryComment(PULL, "x".repeat(65_536), 1, "lgtmoose-summary"),
    ).rejects.toThrow("too long");
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
