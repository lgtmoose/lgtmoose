import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { feedback, findings, pullRequests } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleFeedbackStore } from "./feedback-aws.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
let clock = new Date("2026-06-01T00:00:00Z");
const store = drizzleFeedbackStore(db, () => clock);

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function pull(number: number) {
  const [row] = await db
    .insert(pullRequests)
    .values({
      installationId: 7,
      repo: "acme/shop",
      number,
      author: "dev",
      headSha: SHA,
      baseSha: BASE,
    })
    .returning({ id: pullRequests.id });
  if (row === undefined) throw new Error("no pull request");
  return row.id;
}

async function finding(
  pullRequestId: string,
  options: {
    key: string;
    category?: string;
    status?: "open" | "fixed" | "declined";
    commentId?: number | null;
    source?: "self" | "bot";
    createdAt?: Date;
  },
) {
  const [row] = await db
    .insert(findings)
    .values({
      pullRequestId,
      fingerprint: options.key,
      ruleCategory: options.category ?? "correctness",
      severity: "should_fix",
      path: "src/a.ts",
      line: 12,
      startLine: 10,
      side: "RIGHT",
      title: "Off by one",
      body: "The loop skips the last item.",
      raisedAtSha: SHA,
      source: options.source ?? "self",
      status: options.status ?? "open",
      githubCommentId: options.commentId === undefined ? 1 : options.commentId,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    })
    .returning({ id: findings.id });
  if (row === undefined) throw new Error("no finding");
  return row.id;
}

describe("drizzleFeedbackStore", () => {
  it("lists our recent inline comments, never checked first, and replaces their reactions", async () => {
    const pr = await pull(1);
    const old = await finding(pr, { key: "old", commentId: 10, createdAt: new Date("2026-01-01") });
    const a = await finding(pr, { key: "a", commentId: 11 });
    const b = await finding(pr, { key: "b", commentId: 12 });
    await finding(pr, { key: "none", commentId: null });
    await finding(pr, { key: "theirs", commentId: 13, source: "bot" });
    const since = new Date("2026-05-01");

    const first = await store.commentsToRead(since, 10);
    expect(first.map((comment) => comment.commentId).sort((a, b) => a - b)).toEqual([11, 12]);
    expect(first[0]).toMatchObject({ installationId: 7, repo: "acme/shop" });
    expect(first.some((comment) => comment.findingId === old)).toBe(false);

    await store.replaceReactions(
      a,
      new Map([
        ["ada", "+1"],
        ["bob", "-1"],
      ]),
    );
    // Checked: it goes to the back of the line.
    expect((await store.commentsToRead(since, 1))[0]?.findingId).toBe(b);

    clock = new Date("2026-06-02T00:00:00Z");
    await store.replaceReactions(a, new Map([["ada", "-1"]]));
    const rows = await db.select().from(feedback).where(eq(feedback.findingId, a));
    expect(rows.map((row) => [row.actor, row.reaction])).toEqual([["ada", "-1"]]);
  });

  it("counts findings by category, status and reaction balance, ours only", async () => {
    const pr = await pull(2);
    const liked = await finding(pr, { key: "liked", category: "style", commentId: 21 });
    const disliked = await finding(pr, { key: "disliked", category: "style", commentId: 22 });
    await finding(pr, { key: "declined", category: "style", status: "declined", commentId: 23 });
    await finding(pr, { key: "fixed", category: "style", status: "fixed", commentId: 24 });
    await finding(pr, { key: "bot", category: "style", source: "bot", commentId: 25 });
    await store.replaceReactions(
      liked,
      new Map([
        ["ada", "+1"],
        ["bob", "+1"],
      ]),
    );
    await store.replaceReactions(disliked, new Map([["cy", "-1"]]));

    const counts = (await store.categoryCounts(new Date("2026-05-01"))).filter(
      (count) => count.category === "style",
    );
    const key = (count: (typeof counts)[number]) => `${count.status}/${count.net}`;
    expect(Object.fromEntries(counts.map((count) => [key(count), count]))).toMatchObject({
      "open/1": { findings: 1, thumbsUp: 2, thumbsDown: 0 },
      "open/-1": { findings: 1, thumbsUp: 0, thumbsDown: 1 },
      "declined/0": { findings: 1 },
      "fixed/0": { findings: 1 },
    });
    expect(counts.reduce((total, count) => total + count.findings, 0)).toBe(4);
  });

  it("lists declined findings with what a fixture needs", async () => {
    const pr = await pull(3);
    await finding(pr, { key: "d", category: "naming", status: "declined", commentId: 31 });
    const declined = (await store.declinedFindings(new Date("2026-05-01"), 10)).filter(
      (entry) => entry.prNumber === 3,
    );
    expect(declined).toEqual([
      {
        repo: "acme/shop",
        prNumber: 3,
        path: "src/a.ts",
        line: 12,
        startLine: 10,
        side: "RIGHT",
        category: "naming",
        severity: "should_fix",
        title: "Off by one",
        raisedAtSha: SHA,
        baseSha: BASE,
      },
    ]);
  });
});
