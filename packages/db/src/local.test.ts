import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresQueue, postgresArtifactStore, postgresExecutions } from "./local.js";
import { MIGRATIONS_FOLDER } from "./migrate.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);

// PGlite starts slowly, and more slowly while turbo runs other packages alongside.
beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

describe("PostgresQueue", () => {
  it("hands out each group's messages one at a time, oldest first", async () => {
    const queue = new PostgresQueue(db, "order");
    await queue.send({ groupId: "pr-1", dedupeId: "a", body: "a1" });
    await queue.send({ groupId: "pr-1", dedupeId: "b", body: "a2" });
    await queue.send({ groupId: "pr-2", dedupeId: "c", body: "b1" });

    const first = await queue.receive(10, 60_000);
    expect(first.map((m) => m.body)).toEqual(["a1", "b1"]);
    // pr-1's second waits while its first is in flight.
    expect(await queue.receive(10, 60_000)).toEqual([]);

    await queue.ack(first[0]?.id ?? 0);
    const second = await queue.receive(10, 60_000);
    expect(second.map((m) => m.body)).toEqual(["a2"]);
  });

  it("drops a repeat of a dedupe ID, also after the first is done", async () => {
    const queue = new PostgresQueue(db, "dedupe");
    expect(await queue.send({ groupId: "g", dedupeId: "delivery-1", body: "x" })).toBe(true);
    expect(await queue.send({ groupId: "g", dedupeId: "delivery-1", body: "x" })).toBe(false);
    const [message] = await queue.receive(10, 60_000);
    await queue.ack(message?.id ?? 0);
    expect(await queue.send({ groupId: "g", dedupeId: "delivery-1", body: "x" })).toBe(false);
    // Other queues have their own IDs.
    expect(
      await new PostgresQueue(db, "other").send({
        groupId: "g",
        dedupeId: "delivery-1",
        body: "x",
      }),
    ).toBe(true);
  });

  it("hands a message out again when it isn't acknowledged in time, and holds its group", async () => {
    const queue = new PostgresQueue(db, "visibility");
    await queue.send({ groupId: "g", dedupeId: "1", body: "first" });
    await queue.send({ groupId: "g", dedupeId: "2", body: "second" });
    const [taken] = await queue.receive(1, 0);
    expect(taken?.receiveCount).toBe(1);
    // Its visibility has run out: it comes back before the group's next message.
    const again = await queue.receive(10, 60_000);
    expect(again.map((m) => [m.body, m.receiveCount])).toEqual([["first", 2]]);
  });

  it("retries a failed message later, still ahead of its group", async () => {
    const queue = new PostgresQueue(db, "retry");
    await queue.send({ groupId: "g", dedupeId: "1", body: "first" });
    await queue.send({ groupId: "g", dedupeId: "2", body: "second" });
    const [taken] = await queue.receive(1, 60_000);
    await queue.retryLater(taken?.id ?? 0, 0);
    expect((await queue.receive(10, 60_000)).map((m) => m.body)).toEqual(["first"]);
  });

  it("dead-letters a message with its reason and lets its group go on", async () => {
    const queue = new PostgresQueue(db, "jobs-dl");
    const dead = new PostgresQueue(db, "dead-dl");
    await queue.send({ groupId: "g", dedupeId: "1", body: "bad" });
    await queue.send({ groupId: "g", dedupeId: "2", body: "good" });
    const [bad] = await queue.receive(1, 60_000);
    if (bad === undefined) throw new Error("no message");
    await queue.deadLetter(bad, dead, "not a job");
    expect((await queue.receive(10, 60_000)).map((m) => m.body)).toEqual(["good"]);
    const [letter] = await dead.receive(1, 60_000);
    expect(JSON.parse(letter?.body ?? "{}")).toEqual({
      queue: "jobs-dl",
      reason: "not a job",
      body: "bad",
    });
  });

  it("prunes only messages done long enough ago", async () => {
    const queue = new PostgresQueue(db, "prune");
    await queue.send({ groupId: "g", dedupeId: "1", body: "x" });
    await queue.send({ groupId: "g", dedupeId: "2", body: "y" });
    const [first] = await queue.receive(1, 60_000);
    await queue.ack(first?.id ?? 0);
    expect(await queue.prune(60_000)).toBe(0);
    expect(await queue.prune(-1)).toBe(1);
    // The waiting one is kept.
    expect((await queue.receive(10, 60_000)).map((m) => m.body)).toEqual(["y"]);
  });
});

describe("postgresArtifactStore", () => {
  const store = postgresArtifactStore(db);

  it("creates an object only when there's none, unless it holds exactly this body", async () => {
    const etag = await store.createText("claims/a", "mine");
    expect(etag).toMatch(/^".+"$/);
    // A retry of our own write counts.
    expect(await store.createText("claims/a", "mine")).toBe(etag);
    expect(await store.createText("claims/a", "theirs")).toBeUndefined();
    expect(await store.getTagged("claims/a")).toEqual({ text: "mine", etag });
  });

  it("replaces an object only while it's the version read", async () => {
    const first = (await store.createText("claims/b", "v1")) ?? "";
    const second = await store.replaceText("claims/b", "v2", first);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // A stale ETag fails, unless the object already holds this body.
    expect(await store.replaceText("claims/b", "v3", first)).toBeUndefined();
    expect(await store.replaceText("claims/b", "v2", first)).toBe(second);
    expect(await store.replaceText("claims/missing", "x", first)).toBeUndefined();
    expect(await store.getText("claims/b")).toBe("v2");
  });

  it("deletes an object only while it's the version read", async () => {
    const etag = (await store.createText("claims/c", "x")) ?? "";
    await store.deleteIfMatch("claims/c", '"other"');
    expect(await store.getText("claims/c")).toBe("x");
    await store.deleteIfMatch("claims/c", etag);
    expect(await store.getText("claims/c")).toBeUndefined();
    expect(await store.createText("claims/c", "y")).toBeDefined();
  });

  it("puts text and files over what's there, each with a new ETag", async () => {
    await store.putText("runs/x/a.json", "1");
    const before = await store.getTagged("runs/x/a.json");
    await store.putText("runs/x/a.json", "2");
    const after = await store.getTagged("runs/x/a.json");
    expect(after?.text).toBe("2");
    expect(after?.etag).not.toBe(before?.etag);

    const dir = await mkdtemp(join(tmpdir(), "lgtmoose-artifacts-"));
    try {
      const path = join(dir, "checkout.tar.gz");
      await writeFile(path, Buffer.from([0, 1, 2, 255]));
      await store.putFile("runs/x/checkout.tar.gz", path, "application/gzip");
      expect(await store.getObject("runs/x/checkout.tar.gz")).toEqual({
        body: Buffer.from([0, 1, 2, 255]),
        contentType: "application/gzip",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes old objects under a prefix only", async () => {
    await store.putText("old/1", "x");
    await store.putText("keep/1", "x");
    expect(await store.deleteOlder("old/", new Date(Date.now() + 60_000))).toBe(1);
    expect(await store.getText("keep/1")).toBe("x");
  });
});

describe("postgresExecutions", () => {
  const executions = postgresExecutions(db);

  it("starts a name once, and again only while it runs with the same input", async () => {
    expect(await executions.start("pr-1-abc", { head: "abc" })).toEqual({ started: true });
    expect(await executions.start("pr-1-abc", { head: "abc" })).toEqual({ started: true });
    expect(await executions.start("pr-1-abc", { head: "other" })).toEqual({ started: false });
    const arn = executions.arnOf("pr-1-abc");
    expect(await executions.status(arn)).toBe("RUNNING");

    await executions.finish(arn, "SUCCEEDED");
    expect(await executions.start("pr-1-abc", { head: "abc" })).toEqual({ started: false });
  });

  it("stops only a running execution, and a stopped one stays stopped", async () => {
    await executions.start("pr-2-abc", {});
    const arn = executions.arnOf("pr-2-abc");
    await executions.stop(arn, "a newer push");
    expect(await executions.status(arn)).toBe("ABORTED");
    await executions.finish(arn, "SUCCEEDED");
    expect(await executions.status(arn)).toBe("ABORTED");
    expect(await executions.status(executions.arnOf("never"))).toBeUndefined();
  });

  it("hands each running execution to one runner, and finds those another runner left", async () => {
    await executions.start("pr-3-abc", {});
    const mine = await executions.claim("runner-a", 10);
    expect(mine.map((e) => e.name)).toContain("pr-3-abc");
    expect((await executions.claim("runner-b", 10)).map((e) => e.name)).not.toContain("pr-3-abc");
    expect((await executions.orphaned("runner-b")).map((e) => e.name)).toContain("pr-3-abc");
    expect((await executions.orphaned("runner-a")).map((e) => e.name)).not.toContain("pr-3-abc");
  });
});
