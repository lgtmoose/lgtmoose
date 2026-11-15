import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { findings, learnings, pullRequests } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleLearningStore } from "./drizzle.js";
import { forgetLearning, proposeLearning, type LearningDeps } from "./policy.js";
import type { NewLearning } from "./store.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleLearningStore(db);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

function learning(overrides: Partial<NewLearning> = {}): NewLearning {
  return {
    org: "acme",
    repo: "acme/shop",
    pathGlob: undefined,
    kind: "convention",
    category: undefined,
    text: "Amounts are in cents.",
    status: "active",
    sourceRepo: "acme/shop",
    sourcePr: 1,
    sourceCommentId: 1,
    author: "dana",
    authorPermission: "write",
    ...overrides,
  };
}

const proposed = {
  type: "proposed",
  actor: "dana",
  actorPermission: "write",
  githubCommentId: undefined,
} as const;

describe("drizzleLearningStore", () => {
  it("stores a learning with its events, once per source comment", async () => {
    const first = await store.insert(learning({ sourceCommentId: 10 }), [
      { ...proposed, githubCommentId: 10 },
    ]);
    expect(first.created).toBe(true);
    expect(first.learning).toMatchObject({
      repo: "acme/shop",
      status: "active",
      retiredAt: undefined,
    });
    const again = await store.insert(learning({ sourceCommentId: 10, text: "other" }), [proposed]);
    expect(again).toMatchObject({ created: false, learning: { id: first.learning.id } });
    expect(again.learning.text).toBe("Amounts are in cents.");
    expect(await store.events(first.learning.id)).toMatchObject([
      { type: "proposed", actor: "dana", actorPermission: "write", githubCommentId: 10 },
    ]);
  });

  it("moves a learning only from the statuses given, with an event", async () => {
    const { learning: row } = await store.insert(
      learning({ sourceCommentId: 11, status: "pending" }),
      [],
    );
    const event = {
      type: "approved",
      actor: "lee",
      actorPermission: "admin",
      githubCommentId: undefined,
    } as const;
    expect(await store.transition(row.id, ["active"], "retired", event)).toBeUndefined();
    expect(await store.transition(row.id, ["pending"], "active", event)).toMatchObject({
      status: "active",
    });
    const retired = await store.transition(row.id, ["active"], "retired", {
      ...event,
      type: "retired",
    });
    expect(retired?.retiredAt).toBeInstanceOf(Date);
    expect((await store.events(row.id)).map((e) => e.type)).toEqual(["approved", "retired"]);
  });

  it("lists a repo's learnings with the org-wide ones, by status", async () => {
    await store.insert(learning({ sourceCommentId: 20, repo: undefined, text: "org wide" }), []);
    await store.insert(
      learning({ sourceCommentId: 21, repo: "acme/other", sourceRepo: "acme/other" }),
      [],
    );
    const shop = await store.list({ org: "acme", repo: "acme/shop", status: "active" });
    expect(shop.map((row) => row.repo ?? "org")).not.toContain("acme/other");
    expect(shop.some((row) => row.text === "org wide")).toBe(true);
    expect((await store.list({ org: "acme" })).some((row) => row.repo === "acme/other")).toBe(true);
  });

  it("counts an author's pending learnings in an org, case-insensitively", async () => {
    const pending = (overrides: Partial<NewLearning>) =>
      store.insert(learning({ org: "count", status: "pending", author: "eve", ...overrides }), []);
    await pending({ sourceCommentId: 900 });
    await pending({ sourceCommentId: 901, author: "Eve" });
    await pending({ sourceCommentId: 902, author: "mallory" });
    await pending({ sourceCommentId: 903, status: "active" });
    await pending({ sourceCommentId: 904, org: "elsewhere" });
    expect(await store.countPending("count", "EVE")).toBe(2);
    expect(
      await store.countPending("count", "eve", { sourceRepo: "acme/shop", sourceCommentId: 900 }),
    ).toBe(1);
    expect(await store.countPending("count", "nobody")).toBe(0);
  });

  it("keeps a forgotten learning's row and history", async () => {
    const deps: LearningDeps = {
      store,
      permissions: async () => "write",
      orgRoles: async () => "member",
    };
    const result = await proposeLearning(
      deps,
      { kind: "correction", text: "That helper is safe here.", scope: { level: "repo" } },
      { repo: "acme/shop", pr: 3, commentId: 30, author: "dana" },
    );
    if (result.outcome !== "active") throw new Error("expected active");
    await forgetLearning(deps, result.learning.id, { login: "dana" });
    const [row] = await db.select().from(learnings).where(eq(learnings.id, result.learning.id));
    expect(row).toMatchObject({ status: "retired", sourcePr: 3, sourceCommentId: 30 });
    expect((await store.events(result.learning.id)).map((e) => e.type)).toEqual([
      "proposed",
      "applied",
      "retired",
    ]);
  });

  /** A unit vector along `axis`, mixed a little with the next axis. */
  function unit(axis: number, mix = 0): number[] {
    const vector = Array.from({ length: 1024 }, () => 0);
    vector[axis] = 1;
    vector[axis + 1] = mix;
    return vector;
  }

  it("ranks by pgvector cosine distance, only against the same model's vectors", async () => {
    const a = await store.insert(learning({ sourceCommentId: 200, text: "a" }), []);
    const b = await store.insert(learning({ sourceCommentId: 201, text: "b" }), []);
    const c = await store.insert(learning({ sourceCommentId: 202, text: "c" }), []);
    const ids = [a.learning.id, b.learning.id, c.learning.id];
    expect(await store.missingEmbeddings(ids, "m1")).toEqual(ids);
    await store.setEmbedding(a.learning.id, "m1", unit(0));
    await store.setEmbedding(b.learning.id, "m1", unit(1));
    await store.setEmbedding(c.learning.id, "m2", unit(0));
    // c has another model's vector: it's missing for m1, and never compared with m1's.
    expect(await store.missingEmbeddings(ids, "m1")).toEqual([c.learning.id]);
    expect(await store.nearest(ids, "m1", unit(1, 0.1), 5)).toEqual([b.learning.id, a.learning.id]);
    expect(await store.nearest(ids, "m1", unit(0), 1)).toEqual([a.learning.id]);
    // Reading a learning doesn't carry its vector.
    expect(await store.get(a.learning.id)).not.toHaveProperty("embedding");
  });

  it("counts uses, and lists active learnings unused since a time", async () => {
    const used = await store.insert(learning({ sourceCommentId: 300 }), []);
    const idle = await store.insert(learning({ sourceCommentId: 301 }), []);
    const at = new Date("2030-01-01T00:00:00Z");
    await store.recordUse([used.learning.id, used.learning.id], at);
    expect(await store.get(used.learning.id)).toMatchObject({ hits: 1, lastUsedAt: at });
    const stale = await store.unusedSince(new Date("2029-12-31T00:00:00Z"), 1000);
    const staleIds = stale.map((row) => row.id);
    expect(staleIds).toContain(idle.learning.id);
    expect(staleIds).not.toContain(used.learning.id);
  });
});

describe("drizzleLearningStore outcomes (NIC-1081)", () => {
  let pr = 0;
  async function finding(): Promise<string> {
    pr += 1;
    const [pull] = await db
      .insert(pullRequests)
      .values({
        installationId: 1,
        repo: "acme/shop",
        number: 900 + pr,
        author: "dana",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
      })
      .returning({ id: pullRequests.id });
    if (pull === undefined) throw new Error("no pull request");
    const [row] = await db
      .insert(findings)
      .values({
        pullRequestId: pull.id,
        fingerprint: `fp1:${pr}`,
        ruleCategory: "style",
        severity: "nit",
        title: "Prefer named exports",
        body: "x",
        raisedAtSha: "a".repeat(40),
      })
      .returning({ id: findings.id });
    if (row === undefined) throw new Error("no finding");
    return row.id;
  }

  it("stores a pattern key and lists live patterned learnings", async () => {
    const { learning: row } = await store.insert(
      learning({ sourceCommentId: 9001, patternKey: "style:export named" }),
      [proposed],
    );
    expect(row.patternKey).toBe("style:export named");
    expect((await store.patterned("acme/shop")).map((entry) => entry.id)).toContain(row.id);
  });

  it("reinforces once per finding and counts not-followed events", async () => {
    const { learning: row } = await store.insert(learning({ sourceCommentId: 9002 }), [proposed]);
    const fixed = await finding();
    const declined = await finding();
    const at = new Date();
    await store.recordOutcome([row.id], { type: "reinforced", findingId: fixed }, at);
    await store.recordOutcome([row.id], { type: "reinforced", findingId: fixed }, at);
    await store.recordOutcome(
      [row.id],
      { type: "not_followed", findingId: declined, githubCommentId: 77 },
      at,
    );
    expect((await store.get(row.id))?.hits).toBe(1);
    const events = await store.events(row.id);
    expect(events.map((event) => [event.type, event.findingId ?? null])).toEqual([
      ["proposed", null],
      ["reinforced", fixed],
      ["not_followed", declined],
    ]);
    const counts = await store.notFollowedSince("acme", new Date(at.getTime() - 60_000));
    expect(counts.get(row.id)).toBe(1);
  });
});
