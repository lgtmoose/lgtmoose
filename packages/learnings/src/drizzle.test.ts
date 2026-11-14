import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { learnings } from "@lgtmoose/db";
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

  it("keeps a forgotten learning's row and history", async () => {
    const deps: LearningDeps = { store, permissions: async () => "write" };
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
});
