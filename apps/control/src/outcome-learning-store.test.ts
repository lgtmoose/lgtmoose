import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { feedback, findingEvents, findings, pendingReplies, pullRequests } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzleOutcomeStore } from "./outcome-learning-aws.js";

/** The outcome-learning store's queries (NIC-1081), against the real schema on PGlite. */

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const store = drizzleOutcomeStore(db);
const SHA = "a".repeat(40);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function pull(repo: string, number: number): Promise<string> {
  const [row] = await db
    .insert(pullRequests)
    .values({ installationId: 1, repo, number, author: "dev", headSha: SHA, baseSha: SHA })
    .returning({ id: pullRequests.id });
  if (row === undefined) throw new Error("no pull request");
  return row.id;
}

let fingerprint = 0;
async function finding(
  pullRequestId: string,
  values: { status?: "open" | "declined" | "disputed" | "fixed"; category?: string; title: string },
  learningIds?: string[],
): Promise<string> {
  fingerprint += 1;
  const [row] = await db
    .insert(findings)
    .values({
      pullRequestId,
      fingerprint: `fp1:${fingerprint}`,
      ruleCategory: values.category ?? "style",
      severity: "nit",
      title: values.title,
      body: "x",
      raisedAtSha: SHA,
      status: values.status ?? "open",
      ...(learningIds === undefined ? {} : { learningIds }),
    })
    .returning({ id: findings.id });
  if (row === undefined) throw new Error("no finding");
  return row.id;
}

describe("drizzleOutcomeStore", () => {
  it("reads findings with their prompts' learnings, and the repo's rejected ones", async () => {
    const first = await pull("Acme/Shop", 1);
    const second = await pull("acme/shop", 2);
    const elsewhere = await pull("acme/other", 3);

    // Declined with a reason the reply judge stored.
    const declined = await finding(first, { status: "declined", title: "Prefer named exports" }, [
      "l-1",
    ]);
    await db.insert(pendingReplies).values({
      pullRequestId: first,
      findingId: declined,
      githubCommentId: 7001,
      author: "dana",
      body: "Default exports are fine for pages.",
      status: "judged",
    });
    await db.insert(findingEvents).values({
      findingId: declined,
      type: "declined",
      actor: "human",
      actorLogin: "dana",
      sha: SHA,
      githubCommentId: 7001,
    });
    // Open, with more 👎 than 👍.
    const thumbsDown = await finding(second, { title: "Use named exports" });
    await db.insert(feedback).values([
      { findingId: thumbsDown, reaction: "-1", actor: "erin" },
      { findingId: thumbsDown, reaction: "-1", actor: "finn" },
      { findingId: thumbsDown, reaction: "+1", actor: "gus" },
    ]);
    // Not rejected: fixed, a balanced vote, another category, another repo.
    const fixed = await finding(second, { status: "fixed", title: "Prefer named exports" });
    await db.insert(feedback).values({ findingId: fixed, reaction: "-1", actor: "erin" });
    const balanced = await finding(second, { title: "Named exports" });
    await db.insert(feedback).values([
      { findingId: balanced, reaction: "-1", actor: "erin" },
      { findingId: balanced, reaction: "+1", actor: "gus" },
    ]);
    await finding(second, { status: "declined", category: "naming", title: "Named exports" });
    await finding(elsewhere, { status: "declined", title: "Prefer named exports" });

    expect(await store.findings([declined])).toEqual([
      {
        id: declined,
        repo: "Acme/Shop",
        prNumber: 1,
        category: "style",
        title: "Prefer named exports",
        learningIds: ["l-1"],
      },
    ]);

    const rejected = await store.rejected("acme/shop", "style", new Date(0));
    expect(rejected.map((entry) => entry.findingId).sort()).toEqual([declined, thumbsDown].sort());
    expect(rejected.find((entry) => entry.findingId === declined)).toMatchObject({
      prNumber: 1,
      rejectors: ["dana"],
      reasons: [{ author: "dana", body: "Default exports are fine for pages." }],
    });
    expect(rejected.find((entry) => entry.findingId === thumbsDown)).toMatchObject({
      prNumber: 2,
      reasons: [],
    });
    expect(
      [...(rejected.find((entry) => entry.findingId === thumbsDown)?.rejectors ?? [])].sort(),
    ).toEqual(["erin", "finn"]);
    // Too old to count.
    expect(await store.rejected("acme/shop", "style", new Date(Date.now() + 60_000))).toEqual([]);
  });
});
