import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  findingEvents,
  findings,
  pullRequestDispatches,
  pullRequests,
  reviewRuns,
} from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleConversationStore } from "./conversation-aws.js";
import { drizzleDispatchStore } from "./dispatch-aws.js";

// The migrations create the vector extension (for learnings).
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleConversationStore(db);
const dispatch = drizzleDispatchStore(db);
const T1 = new Date("2026-11-15T00:00:01.000Z");

// PGlite starts slowly, and more slowly while turbo runs other packages alongside.
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

async function finding(
  pullRequestId: string,
  commentId: number,
  options: {
    line?: number;
    startLine?: number;
    status?: "open" | "declined";
    source?: "self" | "bot";
  } = {},
) {
  const [row] = await db
    .insert(findings)
    .values({
      pullRequestId,
      fingerprint: `f${commentId}`,
      ruleCategory: "correctness",
      severity: "should_fix",
      path: "src/a.ts",
      line: options.line ?? 10,
      startLine: options.startLine ?? null,
      side: "RIGHT",
      title: "Off by one",
      body: "The loop skips the last item.",
      raisedAtSha: "h",
      source: options.source ?? "self",
      status: options.status ?? "open",
      githubCommentId: commentId,
    })
    .returning({ id: findings.id });
  if (row === undefined) throw new Error("no finding");
  return row.id;
}

describe("drizzleConversationStore", () => {
  it("pauses and resumes a PR, also one the dispatcher hasn't seen, without moving its events", async () => {
    expect(await dispatch.paused("acme/shop", 40)).toBe(false);
    await store.setPaused("Acme/Shop", 40, "maint");
    expect(await dispatch.paused("acme/shop", 40)).toBe(true);
    // Any job is newer than a PR paused before its first one.
    expect((await dispatch.latest("acme/shop", 40))?.eventAt.getTime()).toBe(0);
    await dispatch.advance("acme/shop", 40, T1, false);
    expect(await dispatch.paused("acme/shop", 40)).toBe(true);
    await store.setPaused("acme/shop", 40, undefined);
    expect(await dispatch.paused("ACME/shop", 40)).toBe(false);
    const [dispatchRow] = await db
      .select()
      .from(pullRequestDispatches)
      .where(eq(pullRequestDispatches.number, 40));
    expect(dispatchRow?.reviewCountResetAt).toBeInstanceOf(Date);
    expect(dispatchRow?.reviewRequestHead).toBeNull();
    expect(dispatchRow?.excludedAutomaticRunId).toBeNull();
    expect(await dispatch.latest("acme/shop", 40)).toEqual({ eventAt: T1, closed: false });
  });

  it("finds our finding by its comment, or by place within its span", async () => {
    const id = await pull(41);
    const single = await finding(id, 801, { line: 10 });
    const span = await finding(id, 802, { line: 20, startLine: 15 });
    await finding(id, 803, { line: 30, source: "bot" });
    expect((await store.findingByComment("acme/shop", 41, 801))?.id).toBe(single);
    expect(await store.findingByComment("acme/shop", 41, 803)).toBeUndefined();
    expect(await store.findingByComment("acme/shop", 42, 801)).toBeUndefined();
    expect((await store.findingsAt("acme/shop", 41, "src/a.ts", 10)).map((row) => row.id)).toEqual([
      single,
    ]);
    expect((await store.findingsAt("acme/shop", 41, "src/a.ts", 17)).map((row) => row.id)).toEqual([
      span,
    ]);
    expect(await store.findingsAt("acme/shop", 41, "src/a.ts", 11)).toEqual([]);
    expect(await store.findingsAt("acme/shop", 41, "src/a.ts", 30)).toEqual([]);
  });

  it("declines an open finding once, with the person's event", async () => {
    const id = await pull(43);
    const open = await finding(id, 811);
    const closed = await finding(id, 812, { status: "declined" });
    expect(await store.decline(open, "maint", 9001)).toBe(true);
    expect(await store.decline(open, "maint", 9002)).toBe(false);
    expect(await store.decline(closed, "maint", 9003)).toBe(false);
    const [row] = await db
      .select({ status: findings.status })
      .from(findings)
      .where(eq(findings.id, open));
    expect(row?.status).toBe("declined");
    const events = await db.select().from(findingEvents).where(eq(findingEvents.findingId, open));
    expect(events).toEqual([
      expect.objectContaining({
        type: "declined",
        actor: "human",
        actorLogin: "maint",
        githubCommentId: 9001,
      }),
    ]);
  });

  it("says whether a head was reviewed", async () => {
    const id = await pull(44);
    await db
      .insert(reviewRuns)
      .values({ pullRequestId: id, headSha: "h1", kind: "first", status: "succeeded" });
    expect(await store.reviewedHead("Acme/Shop", 44, "h1")).toBe(true);
    expect(await store.reviewedHead("Acme/Shop", 44, "h2")).toBe(false);
  });

  it("claims a PR's handle hint once, also on one the dispatcher hasn't seen (NIC-1119)", async () => {
    const claim = (repo: string, number: number) => {
      if (store.claimHandleHint === undefined) throw new Error("no claimHandleHint");
      return store.claimHandleHint(repo, number);
    };
    // Two at once: one of them claims it.
    const both = await Promise.all([claim("Acme/Shop", 51), claim("acme/shop", 51)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await claim("Acme/Shop", 51)).toBe(false);
    // Another PR has its own.
    expect(await claim("Acme/Shop", 52)).toBe(true);
    // A PR the dispatcher already tracks keeps its event time.
    await dispatch.advance("Acme/Shop", 53, T1, false);
    expect(await claim("Acme/Shop", 53)).toBe(true);
    const [row] = await db
      .select()
      .from(pullRequestDispatches)
      .where(eq(pullRequestDispatches.number, 53));
    expect(row?.lastEventAt.toISOString()).toBe(T1.toISOString());
    expect(row?.handleHintAt).toBeInstanceOf(Date);
    // Given back after a failed post, it can be claimed again.
    await store.releaseHandleHint?.("Acme/Shop", 53);
    expect(await claim("Acme/Shop", 53)).toBe(true);
  });

  it("lets a stale unposted hint claim be taken again, never a posted one (NIC-1119)", async () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 22, 12, minutes));
    let clock = at(0);
    const timed = drizzleConversationStore(db, () => clock);
    const claim = (number: number) => {
      if (timed.claimHandleHint === undefined) throw new Error("no claimHandleHint");
      return timed.claimHandleHint("Acme/Shop", number);
    };
    // Claimed, then the Lambda died before posting: a fresh claim still holds.
    expect(await claim(61)).toBe(true);
    clock = at(10);
    expect(await claim(61)).toBe(false);
    // Past the stale time, another comment may post it.
    clock = at(16);
    expect(await claim(61)).toBe(true);
    // Once posted, it's never claimed again.
    expect(await claim(62)).toBe(true);
    await timed.handleHintPosted?.("Acme/Shop", 62);
    clock = at(59);
    expect(await claim(62)).toBe(false);
  });
});
