import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { findingEvents, findings, pendingReplies, pullRequests } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleFindingStore } from "./aws.js";
import { drizzleConversationStore } from "./conversation-aws.js";
import { drizzleReplyStore } from "./replies-aws.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const replies = drizzleReplyStore(db);
const findingStore = drizzleFindingStore(db);
const conversation = drizzleConversationStore(db);

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
      installationId: 1,
      repo: "Acme/Shop",
      number,
      author: "dev",
      headSha: "h",
      baseSha: "b",
    })
    .returning({ id: pullRequests.id });
  if (row === undefined) throw new Error("no pull request");
  return row.id;
}

async function finding(pullRequestId: string, commentId: number) {
  const [row] = await db
    .insert(findings)
    .values({
      pullRequestId,
      fingerprint: `f${commentId}`,
      ruleCategory: "correctness",
      severity: "should_fix",
      path: "src/a.ts",
      line: 10,
      side: "RIGHT",
      title: "Off by one",
      body: "The loop skips the last item.",
      raisedAtSha: "h",
      source: "self",
      githubCommentId: commentId,
    })
    .returning({ id: findings.id });
  if (row === undefined) throw new Error("no finding");
  return row.id;
}

describe("drizzleReplyStore", () => {
  it("records a reply once, redacted, and hands out each finding's latest", async () => {
    const prId = await pull(70);
    const a = await finding(prId, 7001);
    const b = await finding(prId, 7002);
    const base = { repo: "acme/shop", prNumber: 70, author: "dev" };
    expect(await replies.add({ ...base, findingId: a, commentId: 1, body: "first" })).toBe(true);
    expect(await replies.add({ ...base, findingId: a, commentId: 1, body: "again" })).toBe(false);
    await replies.add({
      ...base,
      findingId: a,
      commentId: 2,
      body: "second, password = hunter22",
    });
    await replies.add({ ...base, findingId: b, commentId: 3, body: "on b" });
    // Unknown PR: nothing recorded.
    expect(
      await replies.add({ ...base, prNumber: 999, findingId: a, commentId: 4, body: "x" }),
    ).toBe(false);

    const taken = await replies.take(prId, 10);
    expect(taken.map((reply) => reply.commentId).sort((a, b) => a - b)).toEqual([2, 3]);
    expect(taken.find((reply) => reply.commentId === 2)?.body).not.toContain("hunter22");
    const [first] = await db
      .select({ status: pendingReplies.status })
      .from(pendingReplies)
      .where(eq(pendingReplies.githubCommentId, 1));
    expect(first?.status).toBe("skipped");
    expect(await replies.take(prId, 1)).toHaveLength(1);
  });

  it("marks replies judged, and skips one after too many failed runs", async () => {
    const prId = await pull(71);
    const a = await finding(prId, 7101);
    const b = await finding(prId, 7102);
    const base = { repo: "acme/shop", prNumber: 71, author: "dev" };
    await replies.add({ ...base, findingId: a, commentId: 11, body: "is this right?" });
    await replies.add({ ...base, findingId: b, commentId: 12, body: "fixed" });
    const [one, two] = await replies.take(prId, 10);
    if (one === undefined || two === undefined) throw new Error("expected two replies");
    await replies.finish([one.id], "judged");
    await replies.failed([two.id]);
    await replies.failed([two.id]);
    expect((await replies.take(prId, 10)).map((reply) => reply.attempts)).toEqual([2]);
    await replies.failed([two.id]);
    expect(await replies.take(prId, 10)).toEqual([]);
  });
});

describe("finding store, for replies", () => {
  it("closes an open finding once, with an event naming the reply", async () => {
    const prId = await pull(72);
    const id = await finding(prId, 7201);
    expect(
      await findingStore.closeForReply?.(id, "declined", { login: "lead", commentId: 9 }, "h2"),
    ).toBe(true);
    expect(
      await findingStore.closeForReply?.(id, "fixed", { login: "lead", commentId: 9 }, "h2"),
    ).toBe(false);
    const events = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect(events).toMatchObject([
      { type: "declined", actor: "human", actorLogin: "lead", githubCommentId: 9, sha: "h2" },
    ]);
    // Declined after a reply: raised again, it's dropped like any declined finding.
    expect((await findingStore.closedFindings(prId)).map((row) => row.id)).toEqual([id]);
  });

  it("reopens a fixed finding the reviewer raises again, and never drops the re-raise", async () => {
    const prId = await pull(75);
    const id = await finding(prId, 7501);
    await findingStore.closeForReply?.(id, "fixed", { login: "dev", commentId: 8 }, "h2");
    expect(await findingStore.fixedCommentIds?.(prId)).toEqual([7501]);
    // Not among the closed findings, whose re-raises are dropped.
    expect(await findingStore.closedFindings(prId)).toEqual([]);
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    if (row === undefined) throw new Error("no finding");
    await findingStore.saveFindings(prId, undefined as unknown as string, "h3", [
      {
        fingerprint: row.fingerprint,
        finding: {
          rule_category: row.ruleCategory,
          severity: row.severity,
          path: "src/a.ts",
          line: 10,
          side: "RIGHT",
          title: row.title,
          body: row.body,
          evidence: "x",
        },
      },
    ]);
    expect((await findingStore.trackedFindings(prId)).map((tracked) => tracked.id)).toEqual([id]);
    const events = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect(events.map((event) => event.type)).toEqual(["fixed", "raised"]);
  });

  it("knows which disputes it answered", async () => {
    const prId = await pull(73);
    const id = await finding(prId, 7301);
    const other = await finding(prId, 7302);
    await findingStore.recordReply?.(id, "dispute_answered", 5, "h");
    await findingStore.recordReply?.(other, "replied", 6, "h");
    expect(await findingStore.disputesAnswered?.([id, other])).toEqual(new Set([id]));
  });

  it("moves comments_through forward only", async () => {
    await pull(74);
    const later = new Date("2026-11-15T02:00:00.000Z");
    const earlier = new Date("2026-11-15T01:00:00.000Z");
    await conversation.commentsThrough?.("acme/shop", 74, later);
    await conversation.commentsThrough?.("acme/shop", 74, earlier);
    const [row] = await db
      .select({ through: pullRequests.commentsThrough })
      .from(pullRequests)
      .where(eq(pullRequests.number, 74));
    expect(row?.through?.toISOString()).toBe(later.toISOString());
  });
});
