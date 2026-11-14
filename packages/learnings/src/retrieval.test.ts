import { describe, expect, it } from "vitest";
import {
  appliesTo,
  byKeyword,
  learningsForPullRequest,
  retireUnusedLearnings,
  retrieveLearnings,
  summarizeLearning,
  type Embedder,
} from "./retrieval.js";
import { memoryLearningStore, type Learning, type NewLearning } from "./store.js";

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
    sourceCommentId: undefined,
    author: "dana",
    authorPermission: "write",
    ...overrides,
  };
}

const scope = { org: "Acme", repo: "Acme/Shop", paths: ["src/billing/charge.ts"] };

async function seeded(entries: Partial<NewLearning>[], now?: () => Date) {
  const store = memoryLearningStore(now);
  const rows: Learning[] = [];
  for (const entry of entries) rows.push((await store.insert(learning(entry), [])).learning);
  return { store, rows };
}

/** A fake embedder: each text's vector has a 1 on the axis of the first word it knows. */
function fakeEmbedder(
  axes: Record<string, number>,
  model = "fake:v1",
): Embedder & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts) {
      calls.push([...texts]);
      return texts.map((text) => {
        const vector = Array.from({ length: 1024 }, () => 0);
        const word = Object.keys(axes).find((key) => text.toLowerCase().includes(key));
        vector[word === undefined ? 1023 : (axes[word] ?? 1023)] = 1;
        return vector;
      });
    },
  };
}

describe("appliesTo", () => {
  it("takes the PR's org and repo, org-wide ones, and path globs matching a batch file", async () => {
    const { rows } = await seeded([
      {},
      { repo: undefined },
      { pathGlob: "src/billing/**" },
      { pathGlob: "docs/**" },
      { repo: "acme/other" },
      { org: "globex", repo: "globex/shop" },
      { status: "pending" },
    ]);
    expect(rows.map((row) => appliesTo(row, scope))).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("learningsForPullRequest", () => {
  it("lists what applies, newest first, without counting a use", async () => {
    const { store, rows } = await seeded([{ text: "first" }, { text: "second", repo: undefined }]);
    const listed = await learningsForPullRequest(store, scope);
    expect(listed.map((row) => row.text)).toEqual(["second", "first"]);
    expect((await store.get(rows[0]?.id ?? ""))?.hits).toBe(0);
    expect(listed.map(summarizeLearning).map((entry) => entry.scope)).toEqual(["org", "repo"]);
  });
});

describe("retrieveLearnings", () => {
  it("ranks by keyword without an embedder, keeps the top ones and counts their use", async () => {
    const at = new Date("2030-02-01T00:00:00Z");
    const { store } = await seeded([
      { text: "Retries on the queue use exponential backoff." },
      { text: "Charge amounts are integers in cents, never floats." },
      { text: "Logs use the structured logger." },
    ]);
    const result = await retrieveLearnings(
      { store, now: () => at },
      { ...scope, text: "+ const amount = charge.total * 100; // cents", limit: 2 },
    );
    expect(result.ranking).toBe("keyword");
    expect(result.learnings.map((row) => row.text)[0]).toContain("cents");
    expect(result.learnings).toHaveLength(2);
    const [top] = result.learnings;
    expect(await store.get(top?.id ?? "")).toMatchObject({ hits: 1, lastUsedAt: at });
  });

  it("ranks by embedding, embedding each learning once per model", async () => {
    const { store } = await seeded([
      { text: "Queue retries back off." },
      { text: "Money is in cents." },
      { text: "Logging is structured." },
    ]);
    const embedder = fakeEmbedder({ queue: 0, money: 1, logging: 2, cents: 1 });
    const first = await retrieveLearnings(
      { store, embedder },
      { ...scope, text: "amount in cents", limit: 1 },
    );
    expect(first.ranking).toBe("embedding");
    expect(first.learnings.map((row) => row.text)).toEqual(["Money is in cents."]);
    // Three learnings, then the diff.
    expect(embedder.calls.map((call) => call.length)).toEqual([3, 1]);
    await retrieveLearnings({ store, embedder }, { ...scope, text: "queue", limit: 1 });
    // Already embedded with this model: only the diff now.
    expect(embedder.calls.map((call) => call.length)).toEqual([3, 1, 1]);
    // Another model re-embeds rather than comparing unlike vectors.
    const other = fakeEmbedder({ queue: 0 }, "fake:v2");
    await retrieveLearnings({ store, embedder: other }, { ...scope, text: "queue" });
    expect(other.calls.map((call) => call.length)).toEqual([3, 1]);
  });

  it("falls back to keywords when the embedder fails or returns the wrong size", async () => {
    const { store } = await seeded([{ text: "Money is in cents." }]);
    const logged: string[] = [];
    const broken: Embedder = {
      model: "broken",
      embed: async (texts) => texts.map(() => [1, 2, 3]),
    };
    const result = await retrieveLearnings(
      { store, embedder: broken, log: (message) => logged.push(message) },
      { ...scope, text: "cents" },
    );
    expect(result.ranking).toBe("keyword");
    expect(result.learnings).toHaveLength(1);
    expect(logged).toEqual(["learnings ranked by keyword: the embeddings provider failed"]);
  });

  it("returns nothing, and embeds nothing, when no learning applies", async () => {
    const { store } = await seeded([{ repo: "acme/other" }]);
    const embedder = fakeEmbedder({});
    const result = await retrieveLearnings({ store, embedder }, { ...scope, text: "x" });
    expect(result).toEqual({ learnings: [], ranking: "none" });
    expect(embedder.calls).toEqual([]);
  });
});

describe("byKeyword", () => {
  it("prefers the earlier candidate on a tie", async () => {
    const { rows } = await seeded([{ text: "alpha" }, { text: "beta" }]);
    expect(byKeyword(rows, "nothing shared", 2).map((row) => row.text)).toEqual(["alpha", "beta"]);
  });
});

describe("retireUnusedLearnings", () => {
  it("retires active learnings unused for 90 days, as LGTMoose, keeping their history", async () => {
    let clock = new Date("2030-01-01T00:00:00Z");
    const { store, rows } = await seeded(
      [
        { text: "old, never used" },
        { text: "old, used lately" },
        { text: "pending", status: "pending" },
      ],
      () => clock,
    );
    clock = new Date("2030-03-25T00:00:00Z");
    await store.recordUse([rows[1]?.id ?? ""], clock);
    const now = new Date("2030-04-05T00:00:00Z");
    expect(await retireUnusedLearnings(store, { now })).toBe(1);
    expect((await store.get(rows[0]?.id ?? ""))?.status).toBe("retired");
    expect((await store.get(rows[1]?.id ?? ""))?.status).toBe("active");
    expect((await store.get(rows[2]?.id ?? ""))?.status).toBe("pending");
    expect(await store.events(rows[0]?.id ?? "")).toMatchObject([
      { type: "retired", actor: "lgtmoose", actorPermission: "system" },
    ]);
    // Nothing left to retire.
    expect(await retireUnusedLearnings(store, { now })).toBe(0);
  });
});
