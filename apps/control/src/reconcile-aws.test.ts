import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pullRequests, reviewRuns } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { GitHubClient } from "@lgtmoose/poster";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleRunStore } from "./aws.js";
import { parseQueuedJob } from "./dispatch.js";
import { reconcile } from "./reconcile.js";
import { drizzleReconcileStore, installationGitHub, sqsReconcileQueue } from "./reconcile-aws.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const runs = drizzleRunStore(db);
const store = drizzleReconcileStore(db);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

const X = "1".repeat(40);
const Y = "2".repeat(40);

async function startRun(number: number, headSha: string, executionArn: string, eventAt: Date) {
  return runs.startRun({
    installationId: 5,
    repo: "Acme/Shop",
    number,
    author: "dev",
    headSha,
    baseSha: "b".repeat(40),
    executionArn,
    eventAt,
  });
}

describe("drizzleReconcileStore", () => {
  it("restores a PR's record to the run posted at a head it went back to", async () => {
    const x = await startRun(1, X, "arn:x", new Date("2026-11-14T10:00:00Z"));
    await runs.succeedRun(x.runId, {
      filesDone: 1,
      costUsd: undefined,
      headSha: X,
      statusLabel: "LGTM",
      summaryCommentId: 10,
      review: { event: "APPROVE", id: 100 },
    });
    const y = await startRun(1, Y, "arn:y", new Date("2026-11-14T11:00:00Z"));
    await runs.succeedRun(y.runId, {
      filesDone: 1,
      costUsd: undefined,
      headSha: Y,
      statusLabel: "Requires Changes",
      summaryCommentId: 10,
      review: { event: "REQUEST_CHANGES", id: 200 },
    });

    // Looked up without regard to case.
    const recorded = (await store.pullRequests("acme/shop")).get(1);
    expect(recorded).toMatchObject({
      headSha: Y,
      lastReviewedSha: Y,
      statusLabel: "Requires Changes",
    });
    const posted = await store.postedRunAt(recorded?.id ?? "", X);
    expect(posted).toEqual({
      runId: x.runId,
      headSha: X,
      statusLabel: "LGTM",
      reviewEvent: "APPROVE",
      reviewId: 100,
    });
    if (posted === undefined || recorded === undefined) throw new Error("not found");

    // Not while the record has moved on from the head it was read at.
    expect(await store.restore(recorded.id, X, posted)).toBe(false);
    expect(await store.restore(recorded.id, Y, posted)).toBe(true);
    const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, recorded.id));
    expect(row).toMatchObject({
      headSha: X,
      lastReviewedSha: X,
      statusLabel: "LGTM",
      lastReviewEvent: "APPROVE",
      lastReviewId: 100,
      summaryCommentId: 10,
    });
  });

  it("finds no posted run for a head whose runs didn't post", async () => {
    const run = await startRun(2, X, "arn:2x", new Date("2026-11-14T10:00:00Z"));
    await runs.failRun("arn:2x", "boom");
    expect(await store.postedRunAt(run.pullRequestId, X)).toBeUndefined();
    const [row] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, run.runId));
    expect(row?.statusLabel).toBeNull();
  });
});

describe("sqsReconcileQueue", () => {
  it("sends a job the dispatcher accepts, in the PR's message group", async () => {
    const sent: { input: Record<string, unknown> }[] = [];
    const queue = sqsReconcileQueue(
      {
        send: async (command: { input: Record<string, unknown> }) => {
          sent.push(command);
          return {};
        },
      } as never,
      "https://sqs/jobs.fifo",
    );
    const github = installationGitHub(new GitHubClient({ token: async () => "t" }));
    await reconcile({
      github: {
        installations: async () => [{ id: 3, account: "acme" }],
        forInstallation: async () => ({
          ...github,
          repositories: async () => ["acme/shop"],
          openPulls: async () => [
            {
              number: 4,
              headSha: X,
              baseSha: Y,
              author: "dev",
              authorIsBot: false,
              draft: false,
              labels: [],
              updatedAt: "2026-11-14T10:00:00Z",
            },
          ],
        }),
      },
      store: {
        pullRequests: async () => new Map(),
        postedRunAt: async () => undefined,
        restore: async () => false,
      },
      queue,
      allowedOrgs: ["acme"],
      shadow: true,
      log: () => {},
    });
    expect(sent).toHaveLength(1);
    const input = sent[0]?.input ?? {};
    expect(input).toMatchObject({
      QueueUrl: "https://sqs/jobs.fifo",
      MessageGroupId: "acme/shop#4",
    });
    expect(parseQueuedJob(String(input.MessageBody))).toMatchObject({
      kind: "pr_opened",
      prNumber: 4,
      headSha: X,
    });
  });
});

/** A fetch that answers each path from `replies`, and records what was asked. */
function fakeFetch(replies: Record<string, { status?: number; body: unknown }>) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    asked.push(key);
    const reply = Object.entries(replies).find(([path]) => key.startsWith(path))?.[1];
    if (reply === undefined)
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, asked };
}

describe("installationGitHub", () => {
  it("reads open PRs and skips archived repositories", async () => {
    const { fetchFn } = fakeFetch({
      "/installation/repositories": {
        body: {
          repositories: [{ full_name: "acme/shop" }, { full_name: "acme/old", archived: true }],
        },
      },
      "/repos/acme/shop/pulls": {
        body: [
          {
            number: 4,
            head: { sha: X },
            base: { sha: Y },
            user: { login: "renovate[bot]", type: "Bot" },
            draft: false,
            labels: [{ name: "LGTM" }],
            updated_at: "2026-11-14T10:00:00Z",
          },
        ],
      },
    });
    const github = installationGitHub(new GitHubClient({ token: async () => "t", fetch: fetchFn }));
    expect(await github.repositories()).toEqual(["acme/shop"]);
    expect(await github.openPulls("acme/shop")).toEqual([
      {
        number: 4,
        headSha: X,
        baseSha: Y,
        author: "renovate[bot]",
        authorIsBot: true,
        draft: false,
        labels: ["LGTM"],
        updatedAt: "2026-11-14T10:00:00Z",
      },
    ]);
  });

  it("reads the status labels from the base's config, with defaults when it has none", async () => {
    const yaml = "labels:\n  approved: Ship it\n";
    const { fetchFn, asked } = fakeFetch({
      [`/repos/acme/shop/contents/.lgtmoose.yaml?ref=${X}`]: {
        body: { content: Buffer.from(yaml).toString("base64"), encoding: "base64" },
      },
    });
    const github = installationGitHub(new GitHubClient({ token: async () => "t", fetch: fetchFn }));
    expect(await github.statusLabels("acme/shop", X)).toContain("Ship it");
    expect(await github.statusLabels("acme/shop", Y)).toEqual([
      "Ready for Review",
      "Requires Changes",
      "Approved",
    ]);
    expect(asked).toHaveLength(2);
  });

  it("picks the newest human comment made after the time given", async () => {
    const since = new Date("2026-11-14T10:00:00Z");
    const { fetchFn } = fakeFetch({
      "/repos/acme/shop/issues/4/comments": {
        body: [
          // Edited after `since`, but made before it.
          { id: 1, created_at: "2026-11-14T09:00:00Z", user: { login: "alice" } },
          { id: 2, created_at: "2026-11-14T11:00:00Z", user: { login: "alice" } },
          {
            id: 3,
            created_at: "2026-11-14T13:00:00Z",
            user: { login: "lgtmoose[bot]", type: "Bot" },
          },
        ],
      },
      "/repos/acme/shop/pulls/4/comments": {
        body: [{ id: 4, created_at: "2026-11-14T12:00:00Z", user: { login: "bob" } }],
      },
    });
    const github = installationGitHub(new GitHubClient({ token: async () => "t", fetch: fetchFn }));
    expect(await github.newestHumanComment("acme/shop", 4, since)).toEqual({
      id: 4,
      kind: "review_comment",
      author: "bob",
    });
  });
});
