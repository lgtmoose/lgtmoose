import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrate.js";
import * as schema from "./schema.js";
import {
  DbCooldownStore,
  insertProviderUsage,
  providerUsageRows,
  type ProviderUsageAttempt,
} from "./usage.js";

const client = new PGlite({ extensions: { vector } });
const db = drizzle(client, { schema });
const NOW = new Date("2026-11-13T12:00:00Z");

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

const attempts: ProviderUsageAttempt[] = [
  {
    providerId: "plan",
    tier: "standard",
    model: undefined,
    outcome: "plan_limit",
    cooledUntil: new Date("2026-11-13T17:00:00Z"),
    error: "plan_limit: Usage limit reached.",
  },
  {
    providerId: "api",
    tier: "standard",
    model: "sonnet",
    outcome: "ok",
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, costUsd: 0.0421 },
  },
];

describe("providerUsageRows", () => {
  it("makes one row per attempt, naming where a limit hit fell back to", () => {
    expect(providerUsageRows("run-1", "reviewer", attempts)).toEqual([
      {
        runId: "run-1",
        providerId: "plan",
        role: "reviewer",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        limitHit: true,
        fellBackTo: "api",
        details: {
          outcome: "plan_limit",
          tier: "standard",
          cooledUntil: "2026-11-13T17:00:00.000Z",
          error: "plan_limit: Usage limit reached.",
        },
      },
      {
        runId: "run-1",
        providerId: "api",
        role: "reviewer",
        inputTokens: 1200,
        outputTokens: 300,
        costUsd: "0.0421",
        limitHit: false,
        fellBackTo: null,
        details: { outcome: "ok", tier: "standard", model: "sonnet", cacheReadTokens: 900 },
      },
    ]);
  });

  it("records no fallback when the last provider was limited too", () => {
    const [row] = providerUsageRows("run-1", "reviewer", attempts.slice(0, 1));
    expect(row).toMatchObject({ limitHit: true, fellBackTo: null });
  });
});

describe("insertProviderUsage", () => {
  it("writes the rows for a run", async () => {
    const [pr] = await db
      .insert(schema.pullRequests)
      .values({
        installationId: 1,
        repo: "lgtmoose/usage",
        number: 1,
        author: "someone",
        headSha: "abc",
        baseSha: "def",
      })
      .returning();
    const [run] = await db
      .insert(schema.reviewRuns)
      .values({ pullRequestId: pr?.id ?? "", headSha: "abc", kind: "first" })
      .returning();
    const runId = run?.id ?? "";
    await insertProviderUsage(db, providerUsageRows(runId, "reviewer", attempts));
    await insertProviderUsage(db, []);
    const rows = await db
      .select()
      .from(schema.providerUsage)
      .where(eq(schema.providerUsage.runId, runId));
    expect(rows.map((r) => [r.providerId, r.limitHit, r.fellBackTo, r.costUsd])).toEqual([
      ["plan", true, "api", null],
      ["api", false, null, "0.0421"],
    ]);
  });
});

describe("DbCooldownStore", () => {
  it("keeps the later cooldown and only reports ones that haven't ended", async () => {
    const store = new DbCooldownStore(db);
    const later = new Date(NOW.getTime() + 60 * 60_000);
    await store.coolDown("plan", later, "plan_limit");
    await store.coolDown("plan", new Date(NOW.getTime() + 60_000), "rate_limit");
    await store.coolDown("old", new Date(NOW.getTime() - 1000), "rate_limit");

    expect(await store.cooledUntil(["plan", "old", "fresh"], NOW)).toEqual(
      new Map([["plan", later]]),
    );
    const [row] = await db
      .select()
      .from(schema.providerCooldowns)
      .where(eq(schema.providerCooldowns.providerId, "plan"));
    expect(row?.reason).toBe("plan_limit");
    expect(await store.cooledUntil([], NOW)).toEqual(new Map());
  });
});
