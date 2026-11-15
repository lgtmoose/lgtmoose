import { describe, expect, it } from "vitest";
import {
  approveLearning,
  forgetLearning,
  mayLearningSuppress,
  proposeLearning,
  toCheckedPermission,
  toPermission,
  type LearningDeps,
} from "./policy.js";
import { memoryLearningStore, type OrgRole, type Permission } from "./store.js";

/** Repo permissions by login, and org roles by login (everyone else: none). */
function deps(permissions: Record<string, Permission>, orgRoles: Record<string, OrgRole> = {}) {
  const store = memoryLearningStore();
  const asked: [string, string][] = [];
  const askedOrg: [string, string][] = [];
  const value: LearningDeps = {
    store,
    permissions: async (repo, login) => {
      asked.push([repo, login]);
      return permissions[login] ?? "none";
    },
    orgRoles: async (org, login) => {
      askedOrg.push([org, login]);
      return orgRoles[login] ?? "none";
    },
  };
  return { ...value, store, asked, askedOrg };
}

const source = { repo: "Acme/Shop", pr: 7, commentId: 101, author: "dana" };
const repoScoped = {
  kind: "convention",
  text: "Money amounts are integers in cents.",
  scope: { level: "repo" },
} as const;

describe("proposeLearning", () => {
  it("applies a repo learning at once for an author with write access", async () => {
    const d = deps({ dana: "write" });
    const result = await proposeLearning(d, repoScoped, source);
    expect(result).toMatchObject({ outcome: "active", created: true, redacted: [] });
    if (result.outcome === "refused") throw new Error("refused");
    expect(result.learning).toMatchObject({
      org: "acme",
      repo: "acme/shop",
      sourceRepo: "acme/shop",
      sourcePr: 7,
      sourceCommentId: 101,
      author: "dana",
      authorPermission: "write",
      status: "active",
    });
    expect(d.asked).toEqual([["acme/shop", "dana"]]);
    expect((await d.store.events(result.learning.id)).map((event) => event.type)).toEqual([
      "proposed",
      "applied",
    ]);
  });

  it.each(["triage", "read", "none"] as const)(
    "keeps a learning from an author with %s access pending",
    async (permission) => {
      const d = deps({ dana: permission });
      const result = await proposeLearning(d, repoScoped, source);
      expect(result).toMatchObject({
        outcome: "pending",
        learning: { authorPermission: permission },
      });
      if (result.outcome === "refused") throw new Error("refused");
      expect((await d.store.events(result.learning.id)).map((event) => event.type)).toEqual([
        "proposed",
      ]);
    },
  );

  it("keeps an org-wide learning from a repo admin who isn't an org owner pending", async () => {
    // Anyone who creates a repo in the org is admin on it.
    const d = deps({ dana: "admin" }, { dana: "member" });
    const result = await proposeLearning(d, { ...repoScoped, scope: { level: "org" } }, source);
    expect(result).toMatchObject({
      outcome: "pending",
      learning: { repo: undefined, org: "acme", authorPermission: "org:member" },
    });
    expect(d.askedOrg).toEqual([["acme", "dana"]]);
    expect(d.asked).toEqual([]);
  });

  it("applies an org-wide learning at once for an owner of the org", async () => {
    const d = deps({}, { dana: "admin" });
    const result = await proposeLearning(d, { ...repoScoped, scope: { level: "org" } }, source);
    expect(result).toMatchObject({
      outcome: "active",
      learning: { authorPermission: "org:admin" },
    });
    if (result.outcome === "refused") throw new Error("refused");
    expect(
      (await d.store.events(result.learning.id)).map((e) => [e.type, e.actorPermission]),
    ).toEqual([
      ["proposed", "org:admin"],
      ["applied", "org:admin"],
    ]);
  });

  it("scopes a path learning to the source repo", async () => {
    const result = await proposeLearning(
      deps({ dana: "write" }),
      { ...repoScoped, scope: { level: "path", pathGlob: "src/billing/**" } },
      source,
    );
    expect(result).toMatchObject({
      outcome: "active",
      learning: { repo: "acme/shop", pathGlob: "src/billing/**" },
    });
  });

  it.each(["../other/**", "/etc/**", "src/./x", "a\\b"])(
    "refuses the path glob %s",
    async (glob) => {
      const result = await proposeLearning(
        deps({ dana: "write" }),
        { ...repoScoped, scope: { level: "path", pathGlob: glob } },
        source,
      );
      expect(result.outcome).toBe("refused");
    },
  );

  it("takes the author and permission from GitHub, never from the proposal", async () => {
    const d = deps({ dana: "read" });
    const forged = {
      ...repoScoped,
      author: "admin-bot",
      authorPermission: "admin",
      status: "active",
    };
    expect(await proposeLearning(d, forged, source)).toMatchObject({ outcome: "refused" });
    expect(d.store.all()).toEqual([]);
  });

  it("can't target another repository", async () => {
    const forged = { ...repoScoped, scope: { level: "repo", repo: "acme/other" } };
    expect(await proposeLearning(deps({ dana: "admin" }), forged, source)).toMatchObject({
      outcome: "refused",
    });
  });

  it.each(["authz", "tenant_scoping", "money", "secrets"])(
    "refuses a suppressing learning about the protected category %s",
    async (category) => {
      for (const kind of ["accepted_pattern", "scoping", "correction"] as const) {
        const d = deps({ dana: "admin" });
        const result = await proposeLearning(d, { ...repoScoped, kind, category }, source);
        expect(result).toMatchObject({ outcome: "refused" });
        expect(d.store.all()).toEqual([]);
      }
    },
  );

  it("allows a convention about a protected category: it only adds a rule", async () => {
    const result = await proposeLearning(
      deps({ dana: "write" }),
      { ...repoScoped, category: "tenant_scoping", text: "Every query filters by org_id." },
      source,
    );
    expect(result).toMatchObject({ outcome: "active", learning: { category: "tenant_scoping" } });
  });

  it("redacts the text before storing it, pending ones too", async () => {
    const d = deps({ dana: "read" });
    const result = await proposeLearning(
      d,
      { ...repoScoped, text: `Use token ghp_${"z".repeat(36)} and mail ops@acme.io` },
      source,
    );
    expect(result).toMatchObject({ outcome: "pending", redacted: ["token", "email"] });
    const [stored] = d.store.all();
    expect(stored?.text).toBe("Use token [redacted token] and mail [redacted email]");
  });

  it("stores one learning per source comment", async () => {
    const d = deps({ dana: "write" });
    const first = await proposeLearning(d, repoScoped, source);
    const again = await proposeLearning(d, { ...repoScoped, text: "Something else." }, source);
    expect(again).toMatchObject({ created: false });
    if (first.outcome === "refused" || again.outcome === "refused") throw new Error("refused");
    expect(again.learning.id).toBe(first.learning.id);
    expect(d.store.all()).toHaveLength(1);
    expect(await d.store.events(first.learning.id)).toHaveLength(2);
  });

  it.each([
    ["an unknown kind", { ...repoScoped, kind: "ignore_all" }],
    ["empty text", { ...repoScoped, text: "   " }],
    ["text over the limit", { ...repoScoped, text: "x".repeat(1001) }],
    ["a bad category", { ...repoScoped, category: "Not A Category" }],
    ["no scope", { kind: "convention", text: "x" }],
  ])("refuses %s", async (_name, proposal) => {
    expect(await proposeLearning(deps({ dana: "admin" }), proposal, source)).toMatchObject({
      outcome: "refused",
    });
  });
});

describe("the pending limit per author", () => {
  const proposeFrom = (d: LearningDeps, author: string, commentId: number) =>
    proposeLearning(d, repoScoped, { ...source, author, commentId });

  it("refuses a pending learning past the limit and stores nothing", async () => {
    const d = { ...deps({}), maxPendingPerAuthor: 2 };
    expect((await proposeFrom(d, "eve", 1)).outcome).toBe("pending");
    expect((await proposeFrom(d, "Eve", 2)).outcome).toBe("pending");
    const third = await proposeFrom(d, "eve", 3);
    expect(third).toMatchObject({ outcome: "refused" });
    if (third.outcome !== "refused") throw new Error("not refused");
    expect(third.reason).toContain("the limit is 2");
    expect(await d.store.list({ org: "acme", status: "pending" })).toHaveLength(2);
  });

  it("counts each author on their own", async () => {
    const d = { ...deps({}), maxPendingPerAuthor: 1 };
    expect((await proposeFrom(d, "eve", 1)).outcome).toBe("pending");
    expect((await proposeFrom(d, "mallory", 2)).outcome).toBe("pending");
  });

  it("defaults to 5", async () => {
    const d = deps({});
    for (let i = 1; i <= 5; i++) expect((await proposeFrom(d, "eve", i)).outcome).toBe("pending");
    expect((await proposeFrom(d, "eve", 6)).outcome).toBe("refused");
  });

  it("doesn't limit authors whose learnings apply at once", async () => {
    const d = { ...deps({ dana: "write" }), maxPendingPerAuthor: 1 };
    for (let i = 1; i <= 3; i++) {
      expect((await proposeFrom(d, "dana", i)).outcome).toBe("active");
    }
  });

  it("doesn't count a retried proposal against itself", async () => {
    const d = { ...deps({}), maxPendingPerAuthor: 1 };
    const first = await proposeFrom(d, "eve", 1);
    const again = await proposeFrom(d, "eve", 1);
    expect(again).toMatchObject({ outcome: "pending", created: false });
    if (first.outcome === "refused" || again.outcome === "refused") throw new Error("refused");
    expect(again.learning.id).toBe(first.learning.id);
  });

  it("stops counting a learning once it's approved or retired", async () => {
    const d = { ...deps({ dana: "write" }), maxPendingPerAuthor: 1 };
    const first = await proposeFrom(d, "eve", 1);
    if (first.outcome === "refused") throw new Error("refused");
    await forgetLearning(d, first.learning.id, { login: "dana" });
    expect((await proposeFrom(d, "eve", 2)).outcome).toBe("pending");
  });
});

describe("approveLearning and forgetLearning", () => {
  async function pending(d: ReturnType<typeof deps>, scope: object = { level: "repo" }) {
    const result = await proposeLearning(d, { ...repoScoped, scope }, source);
    if (result.outcome !== "pending") throw new Error(`expected pending, got ${result.outcome}`);
    return result.learning.id;
  }

  it("lets someone with write access approve a pending repo learning", async () => {
    const d = deps({ dana: "read", lee: "write" });
    const id = await pending(d);
    expect(await approveLearning(d, id, { login: "lee", commentId: 202 })).toMatchObject({
      outcome: "done",
      learning: { status: "active", author: "dana", authorPermission: "read" },
    });
    expect((await d.store.events(id)).map((e) => [e.type, e.actor, e.actorPermission])).toEqual([
      ["proposed", "dana", "read"],
      ["approved", "lee", "write"],
    ]);
  });

  it("refuses approval without the access, and leaves it pending", async () => {
    const d = deps({ dana: "read", lee: "triage", ana: "write" });
    const id = await pending(d);
    expect(await approveLearning(d, id, { login: "lee" })).toMatchObject({ outcome: "refused" });
    expect((await d.store.get(id))?.status).toBe("pending");
  });

  it("lets only an org owner approve or forget an org-wide learning", async () => {
    const d = deps(
      { dana: "read", ana: "admin", root: "read" },
      { dana: "member", ana: "member", root: "admin" },
    );
    const id = await pending(d, { level: "org" });
    // Admin on the repo isn't enough.
    expect(await approveLearning(d, id, { login: "ana" })).toMatchObject({
      outcome: "refused",
      reason: "needs an owner of acme (has org:member)",
    });
    expect(await forgetLearning(d, id, { login: "ana" })).toMatchObject({ outcome: "refused" });
    expect((await d.store.get(id))?.status).toBe("pending");
    expect(await approveLearning(d, id, { login: "root", commentId: 9 })).toMatchObject({
      outcome: "done",
      learning: { status: "active" },
    });
    expect(await forgetLearning(d, id, { login: "ana" })).toMatchObject({ outcome: "refused" });
    expect(await forgetLearning(d, id, { login: "root" })).toMatchObject({ outcome: "done" });
    expect((await d.store.events(id)).map((e) => [e.type, e.actor, e.actorPermission])).toEqual([
      ["proposed", "dana", "org:member"],
      ["approved", "root", "org:admin"],
      ["retired", "root", "org:admin"],
    ]);
  });

  it("retires a learning on forget and keeps its row and history", async () => {
    const d = deps({ dana: "write" });
    const result = await proposeLearning(d, repoScoped, source);
    if (result.outcome !== "active") throw new Error("expected active");
    const id = result.learning.id;
    const forgotten = await forgetLearning(d, id, { login: "dana", commentId: 303 });
    expect(forgotten).toMatchObject({ outcome: "done", learning: { status: "retired" } });
    if (forgotten.outcome !== "done") throw new Error("not done");
    expect(forgotten.learning.retiredAt).toBeInstanceOf(Date);
    expect((await d.store.events(id)).map((event) => event.type)).toEqual([
      "proposed",
      "applied",
      "retired",
    ]);
    // Forgetting again, or approving a retired one, changes nothing.
    expect(await forgetLearning(d, id, { login: "dana" })).toMatchObject({ outcome: "unchanged" });
    expect(await approveLearning(d, id, { login: "dana" })).toMatchObject({ outcome: "unchanged" });
    expect(await d.store.events(id)).toHaveLength(3);
  });

  it("refuses forget without write access", async () => {
    const d = deps({ dana: "write", eve: "read" });
    const result = await proposeLearning(d, repoScoped, source);
    if (result.outcome !== "active") throw new Error("expected active");
    expect(await forgetLearning(d, result.learning.id, { login: "eve" })).toMatchObject({
      outcome: "refused",
    });
    expect((await d.store.get(result.learning.id))?.status).toBe("active");
  });

  it("refuses an unknown learning", async () => {
    expect(await forgetLearning(deps({}), "nope", { login: "dana" })).toMatchObject({
      outcome: "refused",
      reason: "no such learning",
    });
  });
});

describe("mayLearningSuppress and toPermission", () => {
  it("never lets a learning suppress a protected category", () => {
    for (const category of ["authz", "tenant_scoping", "money", "secrets"]) {
      expect(mayLearningSuppress(category)).toBe(false);
    }
    expect(mayLearningSuppress("style")).toBe(true);
  });

  it("reads GitHub's role names and treats anything else as none", () => {
    expect(toPermission("maintain")).toBe("maintain");
    expect(toPermission("superuser")).toBe("none");
    expect(toPermission(undefined)).toBe("none");
    expect(toCheckedPermission("org:admin")).toBe("org:admin");
    expect(toCheckedPermission("org:owner")).toBe("org:none");
    expect(toCheckedPermission("write")).toBe("write");
  });
});

describe("proposeLearning options (NIC-1081)", () => {
  it("keeps a learning pending for approval even when its author has write access", async () => {
    const d = deps({ dana: "write" });
    const result = await proposeLearning(d, repoScoped, source, {
      requireApproval: true,
      patternKey: "style:naming",
    });
    expect(result).toMatchObject({
      outcome: "pending",
      learning: { status: "pending", patternKey: "style:naming", authorPermission: "write" },
    });
    if (result.outcome === "refused") throw new Error("refused");
    expect((await d.store.events(result.learning.id)).map((event) => event.type)).toEqual([
      "proposed",
    ]);
  });

  it("doesn't count a write author's held learning against the pending limit", async () => {
    const d = { ...deps({ dana: "write" }), maxPendingPerAuthor: 1 };
    await proposeLearning(d, repoScoped, { ...source, commentId: 1 }, { requireApproval: true });
    const second = await proposeLearning(
      d,
      repoScoped,
      { ...source, commentId: 2 },
      { requireApproval: true },
    );
    expect(second.outcome).toBe("pending");
  });
});

describe("memoryLearningStore outcomes (NIC-1081)", () => {
  it("counts a reinforcement once per finding, and records not followed without a hit", async () => {
    const d = deps({ dana: "write" });
    const result = await proposeLearning(d, repoScoped, source);
    if (result.outcome === "refused") throw new Error("refused");
    const { id } = result.learning;
    const at = new Date("2026-11-15T12:00:00Z");
    await d.store.recordOutcome([id], { type: "reinforced", findingId: "f1" }, at);
    await d.store.recordOutcome([id], { type: "reinforced", findingId: "f1" }, at);
    await d.store.recordOutcome([id], { type: "not_followed", findingId: "f2" }, at);
    expect((await d.store.get(id))?.hits).toBe(1);
    const events = await d.store.events(id);
    expect(events.map((event) => [event.type, event.findingId, event.actor])).toEqual([
      ["proposed", undefined, "dana"],
      ["applied", undefined, "dana"],
      ["reinforced", "f1", "lgtmoose"],
      ["not_followed", "f2", "lgtmoose"],
    ]);
    expect(await d.store.notFollowedSince("acme", new Date(0))).toEqual(new Map([[id, 1]]));
    expect(await d.store.notFollowedSince("other", new Date(0))).toEqual(new Map());
  });

  it("leaves a retired learning alone, and lists only live patterned ones", async () => {
    const d = deps({ dana: "write" });
    const plain = await proposeLearning(d, repoScoped, { ...source, commentId: 1 });
    const patterned = await proposeLearning(
      d,
      repoScoped,
      { ...source, commentId: 2 },
      { patternKey: "style:naming" },
    );
    if (plain.outcome === "refused" || patterned.outcome === "refused") throw new Error("refused");
    expect((await d.store.patterned("acme/shop")).map((learning) => learning.id)).toEqual([
      patterned.learning.id,
    ]);
    await forgetLearning(d, patterned.learning.id, { login: "dana" });
    expect(await d.store.patterned("acme/shop")).toEqual([]);
    await d.store.recordOutcome(
      [patterned.learning.id],
      { type: "reinforced", findingId: "f1" },
      new Date(),
    );
    expect((await d.store.get(patterned.learning.id))?.hits).toBe(0);
  });
});
