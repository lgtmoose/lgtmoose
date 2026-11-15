import { describe, expect, it } from "vitest";
import {
  checkBootstrapProposal,
  learningKey,
  normalizedLearningText,
  storeBootstrapLearning,
} from "./bootstrap.js";
import { approveLearning } from "./policy.js";
import { memoryLearningStore } from "./store.js";

describe("checkBootstrapProposal", () => {
  it("passes a convention, scoped to the repo or a path", () => {
    const repo = checkBootstrapProposal({ kind: "convention", text: "Use the query builder." });
    expect(repo).toMatchObject({ ok: true, proposal: { scope: { level: "repo" } } });
    const path = checkBootstrapProposal({
      kind: "scoping",
      text: "Generated clients aren't reviewed for style.",
      category: "style",
      pathGlob: "src/generated/**",
    });
    expect(path).toMatchObject({
      ok: true,
      proposal: { scope: { level: "path", pathGlob: "src/generated/**" } },
    });
  });

  it("refuses a quieting kind about a protected category", () => {
    for (const kind of ["accepted_pattern", "scoping"] as const) {
      expect(
        checkBootstrapProposal({ kind, text: "Skip auth checks here.", category: "authz" }),
      ).toMatchObject({ ok: false });
    }
    // A convention may name one: it can't quiet anything.
    expect(
      checkBootstrapProposal({ kind: "convention", text: "Check roles first.", category: "authz" }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a glob that leaves the repository", () => {
    expect(
      checkBootstrapProposal({ kind: "scoping", text: "x", pathGlob: "../secrets/**" }),
    ).toMatchObject({ ok: false });
  });

  it("redacts secrets in the text", () => {
    const checked = checkBootstrapProposal({
      kind: "convention",
      text: "Never commit keys like AKIAIOSFODNN7EXAMPLE to the repo.",
    });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.proposal.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(checked.redacted.length).toBeGreaterThan(0);
    }
  });
});

describe("learningKey", () => {
  it("folds case, spacing and punctuation", () => {
    expect(normalizedLearningText("  Use the QUERY builder!  ")).toBe("use the query builder");
    expect(
      learningKey({ repo: "acme/app", pathGlob: undefined, text: "Use the query builder." }),
    ).toBe(learningKey({ repo: "acme/app", pathGlob: undefined, text: "use the  query builder" }));
    expect(learningKey({ repo: "acme/app", pathGlob: "src/**", text: "x" })).not.toBe(
      learningKey({ repo: "acme/app", pathGlob: undefined, text: "x" }),
    );
  });
});

describe("storeBootstrapLearning", () => {
  it("stores a pending learning by LGTMoose, which only a person with write access approves", async () => {
    const store = memoryLearningStore();
    const checked = checkBootstrapProposal({ kind: "convention", text: "Use the query builder." });
    if (!checked.ok) throw new Error("expected a valid proposal");
    const learning = await storeBootstrapLearning(store, checked.proposal, "Acme/App");
    expect(learning).toMatchObject({
      status: "pending",
      org: "acme",
      repo: "acme/app",
      author: "lgtmoose",
      authorPermission: "system",
      sourceCommentId: undefined,
    });
    const deps = {
      store,
      permissions: async (_repo: string, login: string) =>
        login === "maintainer" ? ("write" as const) : ("read" as const),
      orgRoles: async () => "none" as const,
    };
    expect(await approveLearning(deps, learning.id, { login: "reader" })).toMatchObject({
      outcome: "refused",
    });
    expect(await approveLearning(deps, learning.id, { login: "maintainer" })).toMatchObject({
      outcome: "done",
      learning: { status: "active" },
    });
  });

  it("stores two learnings with no source comment side by side", async () => {
    const store = memoryLearningStore();
    for (const text of ["One rule.", "Another rule."]) {
      const checked = checkBootstrapProposal({ kind: "convention", text });
      if (!checked.ok) throw new Error("expected a valid proposal");
      await storeBootstrapLearning(store, checked.proposal, "acme/app");
    }
    expect(store.all()).toHaveLength(2);
  });
});
