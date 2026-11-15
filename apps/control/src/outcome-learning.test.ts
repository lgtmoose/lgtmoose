import { memoryLearningStore, proposeLearning, type Permission } from "@lgtmoose/learnings";
import { describe, expect, it } from "vitest";
import {
  learnFromFixes,
  learnFromRejections,
  learningIdsFor,
  patternKey,
  rememberText,
  repeatLearningText,
  samePattern,
  type OutcomeFinding,
  type OutcomeStore,
  type RejectedFinding,
} from "./outcome-learning.js";

const now = new Date("2026-11-15T12:00:00Z");

function setup(
  permissions: Record<string, Permission>,
  data: { findings: OutcomeFinding[]; rejected: RejectedFinding[] },
) {
  const store = memoryLearningStore(() => now);
  const logs: string[] = [];
  const outcomes: OutcomeStore = {
    async findings(ids) {
      return data.findings.filter((finding) => ids.includes(finding.id));
    },
    async rejected(repo, category) {
      return repo === "acme/shop"
        ? data.rejected.filter(
            (rejected) =>
              data.findings.some(
                (finding) => finding.id === rejected.findingId && finding.category === category,
              ) || category === "style",
          )
        : [];
    },
  };
  return {
    store,
    logs,
    deps: {
      store: outcomes,
      learnings: {
        store,
        permissions: async (_repo: string, login: string) => permissions[login] ?? "none",
        orgRoles: async () => "none" as const,
      },
      log: (message: string) => logs.push(message),
      now: () => now,
    },
  };
}

const finding = (overrides: Partial<OutcomeFinding> = {}): OutcomeFinding => ({
  id: "f2",
  repo: "Acme/Shop",
  prNumber: 12,
  category: "style",
  title: "Prefer named exports over default exports",
  learningIds: [],
  ...overrides,
});

const rejected = (overrides: Partial<RejectedFinding> = {}): RejectedFinding => ({
  findingId: "f2",
  prNumber: 12,
  title: "Prefer named exports over default exports",
  rejectors: ["dana"],
  reasons: [{ author: "dana", body: "Default exports are our convention for pages." }],
  at: now,
  ...overrides,
});

describe("patterns", () => {
  it("matches findings of one category about the same thing", () => {
    const a = patternKey("style", "Prefer named exports over default exports");
    const b = patternKey("style", "Use named exports instead of default exports");
    expect(samePattern(a, b)).toBe(true);
    expect(samePattern(a, patternKey("naming", "Prefer named exports over default exports"))).toBe(
      false,
    );
    expect(samePattern(a, patternKey("style", "Missing error handling in fetch"))).toBe(false);
    // A title with no key nouns is too generic to make a rule of.
    expect(samePattern(patternKey("style", "Do it"), patternKey("style", "Do it"))).toBe(false);
  });

  it("finds the learnings of the batch that reviewed a path", () => {
    const jobs = [{ files: ["a.ts"], learningIds: ["l1"] }, { files: ["b.ts"] }];
    expect(learningIdsFor(jobs, "a.ts")).toEqual(["l1"]);
    expect(learningIdsFor(jobs, "b.ts")).toEqual([]);
    expect(learningIdsFor(jobs, "c.ts")).toEqual([]);
  });

  it("writes short learning texts that quote the reasons", () => {
    const text = repeatLearningText(
      "Prefer named exports",
      "style",
      [3, 7],
      [{ body: "We use default exports for pages." }],
    );
    expect(text).toContain("on 2 pull requests (#3, #7)");
    expect(text).toContain('"We use default exports for pages."');
    expect(
      rememberText({ title: "Prefer named exports", ruleCategory: "style" }, undefined),
    ).not.toContain("reason");
  });
});

describe("learnFromRejections", () => {
  it("proposes nothing after one PR, and a learning once a second PR rejects the same thing", async () => {
    const once = setup({ dana: "write" }, { findings: [finding()], rejected: [rejected()] });
    const [first] = await learnFromRejections(once.deps, ["f2"]);
    expect(first).toEqual({ findingId: "f2", skipped: "rejected on 1 of 2 PRs" });
    expect(once.store.all()).toEqual([]);

    const twice = setup(
      { dana: "write", erin: "admin" },
      {
        findings: [finding()],
        rejected: [
          rejected(),
          rejected({
            findingId: "f1",
            prNumber: 4,
            title: "Use named exports instead of default exports",
            rejectors: ["erin"],
            reasons: [],
          }),
        ],
      },
    );
    const [result] = await learnFromRejections(twice.deps, ["f2"]);
    expect(result).toMatchObject({ proposed: { outcome: "active" } });
    const [learning] = twice.store.all();
    expect(learning).toMatchObject({
      repo: "acme/shop",
      kind: "scoping",
      category: "style",
      status: "active",
      author: "dana",
      sourcePr: 12,
      sourceCommentId: undefined,
      patternKey: patternKey("style", "Prefer named exports over default exports"),
    });
    expect(learning?.text).toContain("(#4, #12)");
  });

  it("waits for approval when one of the people who rejected it lacks write access", async () => {
    const { deps, store } = setup(
      { dana: "write" },
      {
        findings: [finding()],
        rejected: [rejected(), rejected({ findingId: "f1", prNumber: 4, rejectors: ["mallory"] })],
      },
    );
    await learnFromRejections(deps, ["f2"]);
    expect(store.all()).toMatchObject([{ status: "pending", author: "dana" }]);
  });

  it("honours a higher threshold", async () => {
    const { deps, store } = setup(
      { dana: "write" },
      {
        findings: [finding()],
        rejected: [rejected(), rejected({ findingId: "f1", prNumber: 4 })],
      },
    );
    const [result] = await learnFromRejections({ ...deps, repeatThreshold: 3 }, ["f2"]);
    expect(result).toEqual({ findingId: "f2", skipped: "rejected on 2 of 3 PRs" });
    expect(store.all()).toEqual([]);
  });

  it("never proposes one for a protected category", async () => {
    const { deps, store } = setup(
      { dana: "admin" },
      {
        findings: [finding({ category: "authz", title: "Missing authorization check on export" })],
        rejected: [rejected(), rejected({ findingId: "f1", prNumber: 4 })],
      },
    );
    const [result] = await learnFromRejections(deps, ["f2"]);
    expect(result).toEqual({ findingId: "f2", skipped: "protected category" });
    expect(store.all()).toEqual([]);
  });

  it("doesn't propose a pattern that's already learned", async () => {
    const { deps, store } = setup(
      { dana: "write" },
      {
        findings: [finding()],
        rejected: [rejected(), rejected({ findingId: "f1", prNumber: 4 })],
      },
    );
    await learnFromRejections(deps, ["f2"]);
    const [again] = await learnFromRejections(deps, ["f2"]);
    expect(again).toEqual({ findingId: "f2", skipped: "already learned" });
    expect(store.all()).toHaveLength(1);
  });

  it("records the learnings of its category in its prompt as not followed", async () => {
    const { deps, store } = setup({ dana: "write" }, { findings: [], rejected: [] });
    const style = await proposeLearning(
      deps.learnings,
      {
        kind: "scoping",
        category: "style",
        text: "Default exports are fine.",
        scope: { level: "repo" },
      },
      { repo: "acme/shop", commentId: 1, author: "dana" },
    );
    const other = await proposeLearning(
      deps.learnings,
      { kind: "convention", category: "naming", text: "camelCase.", scope: { level: "repo" } },
      { repo: "acme/shop", commentId: 2, author: "dana" },
    );
    if (style.outcome === "refused" || other.outcome === "refused") throw new Error("refused");
    const withPrompt = setup(
      { dana: "write" },
      {
        findings: [finding({ learningIds: [style.learning.id, other.learning.id] })],
        rejected: [rejected()],
      },
    );
    await learnFromRejections(
      { ...withPrompt.deps, learnings: { ...withPrompt.deps.learnings, store } },
      ["f2"],
      new Map([["f2", 55]]),
    );
    expect(await store.notFollowedSince("acme", new Date(0))).toEqual(
      new Map([[style.learning.id, 1]]),
    );
    const events = await store.events(style.learning.id);
    expect(events.at(-1)).toMatchObject({
      type: "not_followed",
      findingId: "f2",
      githubCommentId: 55,
      actor: "lgtmoose",
    });
  });
});

describe("learnFromFixes", () => {
  it("counts a hit for each learning in a fixed finding's prompt", async () => {
    const { deps, store } = setup({ dana: "write" }, { findings: [], rejected: [] });
    const proposed = await proposeLearning(
      deps.learnings,
      { kind: "convention", text: "Amounts in cents.", scope: { level: "repo" } },
      { repo: "acme/shop", commentId: 1, author: "dana" },
    );
    if (proposed.outcome === "refused") throw new Error("refused");
    const fixedFinding = finding({ id: "f9", learningIds: [proposed.learning.id] });
    const fixed = setup({ dana: "write" }, { findings: [fixedFinding], rejected: [] });
    const count = await learnFromFixes({ ...fixed.deps, learnings: { store } }, [
      { findingId: "f9", commentId: 3 },
    ]);
    expect(count).toBe(1);
    expect((await store.get(proposed.learning.id))?.hits).toBe(1);
  });
});
