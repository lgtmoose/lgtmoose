import type { ReviewJob } from "@lgtmoose/core";
import { memoryLearningStore, type OrgRole, type Permission } from "@lgtmoose/learnings";
import { describe, expect, it } from "vitest";
import {
  handleConversation,
  REPLY_MARKER,
  type CommentInfo,
  type ConversationDeps,
  type StoredFinding,
} from "./conversation.js";

const HEAD = "c".repeat(40);

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    kind: "comment",
    deliveryId: "d-1",
    installationId: 7,
    repo: "acme/shop",
    prNumber: 12,
    actor: "dev",
    commentId: 500,
    receivedAt: "2026-11-15T00:00:00.000Z",
    eventAt: "2026-11-15T00:00:00.000Z",
    ...overrides,
  };
}

function finding(overrides: Partial<StoredFinding> = {}): StoredFinding {
  return {
    id: "f-1",
    severity: "should_fix",
    ruleCategory: "correctness",
    title: "Off by one @team [link](https://x)",
    body: "The loop skips the last item.",
    path: "src/a.ts",
    line: 10,
    status: "open",
    raisedAtSha: HEAD,
    ...overrides,
  };
}

/** Fake GitHub and stores; `permissions` and `orgRoles` by login. */
function fakeDeps(
  comment: CommentInfo,
  options: {
    permissions?: Record<string, Permission>;
    /** Per repository (`owner/name`), then by login; overrides `permissions` there. */
    repoPermissions?: Record<string, Record<string, Permission>>;
    orgRoles?: Record<string, OrgRole>;
    pullAuthor?: string;
    open?: boolean;
    findings?: Map<number, StoredFinding>;
    reviewed?: boolean;
    shadow?: boolean;
  } = {},
) {
  const reactions: string[] = [];
  const replies: { kind: string; commentId: number; body: string }[] = [];
  const queued: ReviewJob[] = [];
  const paused = new Map<string, string | undefined>();
  const declined: string[] = [];
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  const learnings = memoryLearningStore();
  const asked: string[] = [];
  const findings = options.findings ?? new Map<number, StoredFinding>();
  const deps: ConversationDeps = {
    async github() {
      return {
        slug: async () => "lgtmoose",
        comment: async () => comment,
        pull: async () => ({
          headSha: HEAD,
          author: options.pullAuthor ?? "author",
          open: options.open ?? true,
        }),
        files: async () => ["src/a.ts", "docs/b.md"],
        permission: async (repo, login) => {
          asked.push(`${repo}:${login}`);
          return options.repoPermissions?.[repo]?.[login] ?? options.permissions?.[login] ?? "read";
        },
        orgRole: async (_org, login) => options.orgRoles?.[login] ?? "none",
        react: async (_kind, _repo, commentId, content) => {
          reactions.push(`${commentId}:${content}`);
        },
        reply: async (kind, _repo, _number, commentId, body) => {
          replies.push({ kind, commentId, body });
        },
      };
    },
    store: {
      async setPaused(repo, number, by) {
        paused.set(`${repo}#${number}`, by);
      },
      reviewedHead: async () => options.reviewed ?? false,
      findingByComment: async (_repo, _number, id) => findings.get(id),
      findingsAt: async (_repo, _number, path, line) =>
        [...findings.values()].filter((row) => row.path === path && row.line === line),
      async decline(id) {
        const row = [...findings.values()].find((candidate) => candidate.id === id);
        if (row === undefined || (row.status !== "open" && row.status !== "outdated")) return false;
        row.status = "declined";
        declined.push(id);
        return true;
      },
    },
    learnings,
    queue: {
      async send(queuedJob) {
        queued.push(queuedJob);
      },
    },
    shadow: options.shadow ?? false,
    log: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
    now: () => new Date("2026-11-15T00:00:05.000Z"),
  };
  return { deps, reactions, replies, queued, paused, declined, learnings, logs, asked };
}

const from = (author: string, body: string, extra: Partial<CommentInfo> = {}): CommentInfo => ({
  body,
  author,
  authorIsBot: false,
  ...extra,
});

describe("handleConversation", () => {
  it("leaves a top-level comment without a command alone", async () => {
    const f = fakeDeps(from("dev", "Looks good, thanks @lgtmoose-fan"));
    expect(await handleConversation(f.deps, job())).toEqual({
      action: "deferred",
      reason: "not a reply on a review thread",
    });
    expect(f.reactions).toEqual([]);
  });

  describe("replies for the reply judge", () => {
    function withReplies(body: string, status: StoredFinding["status"] = "open") {
      const f = fakeDeps(
        from("dev", body, { threadRootId: 100, createdAt: "2026-11-15T00:00:03.000Z" }),
        { findings: new Map([[100, finding({ status })]]) },
      );
      const added: { findingId: string; commentId: number; body: string }[] = [];
      const through: Date[] = [];
      f.deps.replies = {
        add: async (input) => {
          if (added.some((entry) => entry.commentId === input.commentId)) return false;
          added.push(input);
          return true;
        },
        take: async () => [],
        finish: async () => {},
        failed: async () => {},
      };
      f.deps.store.commentsThrough = async (_repo, _number, at) => {
        through.push(at);
      };
      return { ...f, added, through };
    }
    const reviewReply = job({ kind: "review_comment", commentId: 501 });

    it("records a reply on one of our findings' threads and asks for a run", async () => {
      const f = withReplies("This is intended: we retry later.");
      expect(await handleConversation(f.deps, reviewReply)).toEqual({
        action: "reply",
        queued: true,
      });
      expect(f.added).toMatchObject([{ findingId: "f-1", commentId: 501 }]);
      expect(f.queued).toMatchObject([
        {
          kind: "pr_updated",
          requested: "replies",
          deliveryId: "replies-501",
          headSha: HEAD,
          commentId: 501,
        },
      ]);
      expect(f.through.map((at) => at.toISOString())).toEqual(["2026-11-15T00:00:03.000Z"]);
      // A redelivery is recorded once and asks once.
      expect(await handleConversation(f.deps, reviewReply)).toEqual({
        action: "reply",
        queued: false,
      });
      expect(f.queued).toHaveLength(1);
    });

    it("leaves thanks, closed findings and other threads alone", async () => {
      const thanks = withReplies("Thanks! 👍");
      expect(await handleConversation(thanks.deps, reviewReply)).toMatchObject({
        action: "ignored",
        reason: "nothing to judge",
      });
      const closed = withReplies("Why?", "declined");
      expect(await handleConversation(closed.deps, reviewReply)).toMatchObject({
        action: "ignored",
      });
      const other = withReplies("Why?");
      expect(
        await handleConversation(other.deps, job({ kind: "review_comment", commentId: 100 })),
      ).toMatchObject({ action: "deferred" });
      for (const f of [thanks, closed, other]) {
        expect(f.added).toEqual([]);
        expect(f.queued).toEqual([]);
      }
      // Handled all the same: the reconciler needn't send them again.
      expect(thanks.through).toHaveLength(1);
    });

    it("moves comments_through after a command too", async () => {
      const f = withReplies("@lgtmoose help");
      await handleConversation(f.deps, reviewReply);
      expect(f.through).toHaveLength(1);
      expect(f.added).toEqual([]);
    });
  });

  it("ignores bots, our own replies and submitted reviews", async () => {
    const bot = fakeDeps(from("ci[bot]", "@lgtmoose review", { authorIsBot: true }));
    expect(await handleConversation(bot.deps, job())).toMatchObject({ action: "ignored" });
    const ours = fakeDeps(from("dev", `@lgtmoose help\n\n${REPLY_MARKER}`));
    expect(await handleConversation(ours.deps, job())).toMatchObject({ action: "ignored" });
    const review = fakeDeps(from("dev", "@lgtmoose review"));
    expect(await handleConversation(review.deps, job({ kind: "review" }))).toMatchObject({
      action: "deferred",
    });
  });

  it("answers help and unknown commands with the help text", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose deploy"));
    expect(await handleConversation(f.deps, job())).toMatchObject({
      action: "commands",
      ok: false,
      replied: true,
    });
    expect(f.reactions).toEqual(["500:confused"]);
    expect(f.replies[0]?.body).toContain("@lgtmoose full review");
    expect(f.replies[0]?.body).toContain(REPLY_MARKER);
  });

  it("queues a review the PR's author asks for, with only a reaction", async () => {
    const f = fakeDeps(from("author", "@lgtmoose review"));
    expect(await handleConversation(f.deps, job())).toMatchObject({ ok: true, replied: false });
    expect(f.queued).toEqual([
      expect.objectContaining({
        kind: "pr_updated",
        requested: "review",
        deliveryId: "command-500-review",
        headSha: HEAD,
        actor: "author",
        eventAt: "2026-11-15T00:00:00.000Z",
      }),
    ]);
    expect(f.reactions).toEqual(["500:+1"]);
  });

  it("says a reviewed head is reviewed, and a full review queues anyway", async () => {
    const reviewed = fakeDeps(from("author", "@lgtmoose review"), { reviewed: true });
    await handleConversation(reviewed.deps, job());
    expect(reviewed.queued).toEqual([]);
    expect(reviewed.replies[0]?.body).toContain("already reviewed");
    const full = fakeDeps(from("author", "@lgtmoose full review"), { reviewed: true });
    await handleConversation(full.deps, job());
    expect(full.queued).toEqual([
      expect.objectContaining({ requested: "full_review", deliveryId: "command-500-full" }),
    ]);
  });

  it("refuses a review from someone who is neither the author nor a writer, or on a closed PR", async () => {
    const drive = fakeDeps(from("visitor", "@lgtmoose full review"));
    expect(await handleConversation(drive.deps, job())).toMatchObject({ ok: false });
    expect(drive.queued).toEqual([]);
    const writer = fakeDeps(from("maint", "@lgtmoose review"), { permissions: { maint: "write" } });
    await handleConversation(writer.deps, job());
    expect(writer.queued).toHaveLength(1);
    const closed = fakeDeps(from("author", "@lgtmoose review"), { open: false });
    await handleConversation(closed.deps, job());
    expect(closed.queued).toEqual([]);
    expect(closed.replies[0]?.body).toContain("closed");
  });

  it("pauses and resumes for someone with write access only", async () => {
    const reader = fakeDeps(from("author", "@lgtmoose pause"));
    expect(await handleConversation(reader.deps, job())).toMatchObject({ ok: false });
    expect(reader.paused.size).toBe(0);
    expect(reader.replies[0]?.body).toContain("needs write access");
    const maint = fakeDeps(from("maint", "@lgtmoose pause\n@lgtmoose resume"), {
      permissions: { maint: "maintain" },
    });
    expect(await handleConversation(maint.deps, job())).toMatchObject({ ok: true, replied: false });
    expect(maint.paused.get("acme/shop#12")).toBeUndefined();
    expect(maint.paused.has("acme/shop#12")).toBe(true);
  });

  it("learns from a writer at once, and keeps a reader's learning pending", async () => {
    const writer = fakeDeps(
      from("maint", "@lgtmoose learn: [path src/**] Use the shared logger."),
      {
        permissions: { maint: "write" },
      },
    );
    await handleConversation(writer.deps, job());
    const [active] = writer.learnings.all();
    expect(active).toMatchObject({
      status: "active",
      author: "maint",
      sourceCommentId: 500,
      sourcePr: 12,
      pathGlob: "src/**",
    });
    expect(writer.replies[0]?.body).toContain("is active");
    const reader = fakeDeps(from("visitor", "@lgtmoose learn: Prefer zod. token=abcdefgh1234"));
    await handleConversation(reader.deps, job());
    const [pending] = reader.learnings.all();
    expect(pending?.status).toBe("pending");
    expect(pending?.text).not.toContain("abcdefgh1234");
    expect(reader.replies[0]?.body).toContain("pending");
    expect(reader.replies[0]?.body).toContain("secret value");
  });

  it("needs an org owner for an org-wide learning", async () => {
    const admin = fakeDeps(from("repoadmin", "@lgtmoose learn: [org] Use pnpm."), {
      permissions: { repoadmin: "admin" },
      orgRoles: { repoadmin: "member" },
    });
    await handleConversation(admin.deps, job());
    expect(admin.learnings.all()[0]?.status).toBe("pending");
    const owner = fakeDeps(from("boss", "@lgtmoose learn: [org] Use pnpm."), {
      orgRoles: { boss: "admin" },
    });
    await handleConversation(owner.deps, job());
    expect(owner.learnings.all()[0]?.status).toBe("active");
  });

  it("refuses a learning that would quiet a protected category", async () => {
    const f = fakeDeps(
      from("maint", "@lgtmoose learn: [kind accepted_pattern] [category authz] Skip checks."),
      { permissions: { maint: "write" } },
    );
    expect(await handleConversation(f.deps, job())).toMatchObject({ ok: false });
    expect(f.learnings.all()).toEqual([]);
  });

  it("lists the learnings that apply, escaped, and forgets one for a writer", async () => {
    const f = fakeDeps(from("maint", "@lgtmoose learn: Ping @team about [this](https://x)."), {
      permissions: { maint: "write" },
    });
    await handleConversation(f.deps, job());
    const [learning] = f.learnings.all();
    const id = learning?.id ?? "";
    const list = fakeDeps(from("visitor", "@lgtmoose learnings"));
    // Same store: the learning from the first comment.
    list.deps.learnings = f.learnings;
    await handleConversation(list.deps, job({ commentId: 501 }));
    const body = list.replies[0]?.body ?? "";
    expect(body).toContain(id);
    expect(body).not.toMatch(/(^|[^\\])@team/);
    expect(body).not.toContain("[this](https://x)");

    const forget = fakeDeps(from("visitor", `@lgtmoose forget ${id}`));
    forget.deps.learnings = f.learnings;
    expect(await handleConversation(forget.deps, job({ commentId: 502 }))).toMatchObject({
      ok: false,
    });
    const maint = fakeDeps(from("maint", `@lgtmoose forget ${id}`), {
      permissions: { maint: "write" },
    });
    maint.deps.learnings = f.learnings;
    await handleConversation(maint.deps, job({ commentId: 503 }));
    expect(maint.replies).toEqual([]);
    expect((await f.learnings.get(id))?.status).toBe("retired");
  });

  it("approves a pending learning only for someone with write access", async () => {
    const f = fakeDeps(from("visitor", "@lgtmoose learn: Prefer zod."));
    await handleConversation(f.deps, job());
    const id = f.learnings.all()[0]?.id ?? "";
    expect((await f.learnings.get(id))?.status).toBe("pending");

    const reader = fakeDeps(from("visitor", `@lgtmoose approve ${id}`));
    reader.deps.learnings = f.learnings;
    expect(await handleConversation(reader.deps, job({ commentId: 601 }))).toMatchObject({
      ok: false,
    });
    expect(reader.replies[0]?.body).toContain("Not approved");
    expect((await f.learnings.get(id))?.status).toBe("pending");

    const maint = fakeDeps(from("maint", `@lgtmoose approve ${id}`), {
      permissions: { maint: "write" },
    });
    maint.deps.learnings = f.learnings;
    await handleConversation(maint.deps, job({ commentId: 602 }));
    expect(maint.replies[0]?.body).toContain("is active");
    expect((await f.learnings.get(id))?.status).toBe("active");
    const events = await f.learnings.events(id);
    expect(events.at(-1)).toMatchObject({ type: "approved", actor: "maint" });

    const again = fakeDeps(from("maint", `@lgtmoose approve ${id}`), {
      permissions: { maint: "write" },
    });
    again.deps.learnings = f.learnings;
    await handleConversation(again.deps, job({ commentId: 603 }));
    expect(again.replies[0]?.body).toContain("already active");
  });

  it("needs an org owner to approve an org-wide learning", async () => {
    const f = fakeDeps(from("visitor", "@lgtmoose learn: [org] Use pnpm."));
    await handleConversation(f.deps, job());
    const id = f.learnings.all()[0]?.id ?? "";
    const admin = fakeDeps(from("repoadmin", `@lgtmoose approve ${id}`), {
      permissions: { repoadmin: "admin" },
      orgRoles: { repoadmin: "member" },
    });
    admin.deps.learnings = f.learnings;
    await handleConversation(admin.deps, job({ commentId: 611 }));
    expect((await f.learnings.get(id))?.status).toBe("pending");
    const owner = fakeDeps(from("boss", `@lgtmoose approve ${id}`), {
      orgRoles: { boss: "admin" },
    });
    owner.deps.learnings = f.learnings;
    await handleConversation(owner.deps, job({ commentId: 612 }));
    expect((await f.learnings.get(id))?.status).toBe("active");
  });

  it("checks access on the learning's own repository, not the PR's", async () => {
    // A pending learning proposed on acme/billing.
    const f = fakeDeps(from("visitor", "@lgtmoose learn: Amounts are in cents."));
    await handleConversation(f.deps, job({ repo: "acme/billing" }));
    const id = f.learnings.all()[0]?.id ?? "";
    expect((await f.learnings.get(id))?.status).toBe("pending");

    // Write on acme/shop (where the PR is), only read on acme/billing.
    const onlyShop = {
      "acme/shop": { maint: "write" as const },
      "acme/billing": { maint: "read" as const },
    };
    for (const verb of ["approve", "forget"]) {
      const g = fakeDeps(from("maint", `@lgtmoose ${verb} ${id}`), { repoPermissions: onlyShop });
      g.deps.learnings = f.learnings;
      expect(await handleConversation(g.deps, job({ commentId: 701 }))).toMatchObject({
        ok: false,
      });
      expect(g.asked).toContain("acme/billing:maint");
    }
    expect((await f.learnings.get(id))?.status).toBe("pending");

    // With write on acme/billing, from the same acme/shop PR, it's allowed.
    const both = {
      "acme/shop": { maint: "write" as const },
      "acme/billing": { maint: "write" as const },
    };
    const ok = fakeDeps(from("maint", `@lgtmoose approve ${id}`), { repoPermissions: both });
    ok.deps.learnings = f.learnings;
    await handleConversation(ok.deps, job({ commentId: 702 }));
    expect((await f.learnings.get(id))?.status).toBe("active");
    const gone = fakeDeps(from("maint", `@lgtmoose forget ${id}`), { repoPermissions: both });
    gone.deps.learnings = f.learnings;
    await handleConversation(gone.deps, job({ commentId: 703 }));
    expect((await f.learnings.get(id))?.status).toBe("retired");
  });

  it("still needs an org owner for an org-wide learning, whatever the repository access", async () => {
    const f = fakeDeps(from("visitor", "@lgtmoose learn: [org] Use pnpm."));
    await handleConversation(f.deps, job({ repo: "acme/billing" }));
    const id = f.learnings.all()[0]?.id ?? "";
    const g = fakeDeps(from("maint", `@lgtmoose approve ${id}`), {
      permissions: { maint: "admin" },
      orgRoles: { maint: "member" },
    });
    g.deps.learnings = f.learnings;
    await handleConversation(g.deps, job({ commentId: 711 }));
    expect((await f.learnings.get(id))?.status).toBe("pending");
  });

  it("won't approve another account's learning", async () => {
    const f = fakeDeps(from("visitor", "@lgtmoose learn: Use pnpm."));
    await handleConversation(f.deps, job({ repo: "other/app" }));
    const id = f.learnings.all()[0]?.id ?? "";
    const g = fakeDeps(from("maint", `@lgtmoose approve ${id}`), {
      permissions: { maint: "admin" },
    });
    g.deps.learnings = f.learnings;
    expect(await handleConversation(g.deps, job())).toMatchObject({ ok: false });
    expect(g.replies[0]?.body).toContain("no such learning");
    expect((await f.learnings.get(id))?.status).toBe("pending");
  });

  it("refuses a learn: past the author's pending limit, storing nothing", async () => {
    const f = fakeDeps(from("visitor", "@lgtmoose learn: Prefer zod."));
    f.deps.maxPendingLearnings = 1;
    await handleConversation(f.deps, job());
    const g = fakeDeps(from("visitor", "@lgtmoose learn: Prefer pnpm."));
    g.deps.learnings = f.learnings;
    g.deps.maxPendingLearnings = 1;
    expect(await handleConversation(g.deps, job({ commentId: 621 }))).toMatchObject({ ok: false });
    expect(g.replies[0]?.body).toContain("Not learned");
    expect(f.learnings.all()).toHaveLength(1);
  });

  it("won't forget another account's learning", async () => {
    const f = fakeDeps(from("maint", "@lgtmoose learn: Use pnpm."), {
      permissions: { maint: "write" },
    });
    await handleConversation(f.deps, job({ repo: "other/app" }));
    const id = f.learnings.all()[0]?.id ?? "";
    const g = fakeDeps(from("maint", `@lgtmoose forget ${id}`), {
      permissions: { maint: "admin" },
    });
    g.deps.learnings = f.learnings;
    expect(await handleConversation(g.deps, job())).toMatchObject({ ok: false });
    expect((await f.learnings.get(id))?.status).toBe("active");
  });

  it("explains a finding from its thread or by place, escaping its text", async () => {
    const findings = new Map([[900, finding()]]);
    const inThread = fakeDeps(from("visitor", "@lgtmoose explain", { threadRootId: 900 }), {
      findings,
    });
    await handleConversation(inThread.deps, job({ kind: "review_comment", commentId: 901 }));
    const body = inThread.replies[0]?.body ?? "";
    expect(inThread.replies[0]?.kind).toBe("review_comment");
    expect(body).toContain("The loop skips the last item");
    expect(body).toContain("should_fix");
    expect(body).not.toContain("[link](https://x)");
    const byPlace = fakeDeps(from("visitor", "@lgtmoose explain src/a.ts:10"), { findings });
    await handleConversation(byPlace.deps, job());
    expect(byPlace.replies[0]?.body).toContain("The loop skips");
    const nothing = fakeDeps(from("visitor", "@lgtmoose explain src/a.ts:99"), { findings });
    expect(await handleConversation(nothing.deps, job())).toMatchObject({ ok: false });
  });

  describe("explain with a model", () => {
    function withExplainer(
      author: string,
      body: string,
      options: { status?: StoredFinding["status"]; permissions?: Record<string, Permission> } = {},
      extra: Partial<CommentInfo> = {},
    ) {
      const findings = new Map([[900, finding({ status: options.status ?? "open" })]]);
      const f = fakeDeps(from(author, body, extra), {
        findings,
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
      });
      const added: { findingId: string; commentId: number; kind?: string }[] = [];
      f.deps.replies = {
        add: async (input) => {
          if (added.some((entry) => entry.commentId === input.commentId)) return false;
          added.push(input);
          return true;
        },
        take: async () => [],
        finish: async () => {},
        failed: async () => {},
      };
      f.deps.maxExplanations = 5;
      return { ...f, added };
    }
    const inThread = job({ kind: "review_comment", commentId: 901 });

    it("asks the explainer in the finding's thread, once, and replies nothing yet", async () => {
      const f = withExplainer("author", "@lgtmoose explain", {}, { threadRootId: 900 });
      expect(await handleConversation(f.deps, inThread)).toMatchObject({
        ok: true,
        replied: false,
      });
      expect(f.added).toMatchObject([{ findingId: "f-1", commentId: 901, kind: "explain" }]);
      expect(f.queued).toMatchObject([
        { kind: "pr_updated", requested: "explain", deliveryId: "explain-901", headSha: HEAD },
      ]);
      expect(f.reactions).toEqual(["901:+1"]);
      // A redelivery asks once.
      await handleConversation(f.deps, inThread);
      expect(f.queued).toHaveLength(1);
    });

    it("answers on the PR for an explain by place, for someone with write access", async () => {
      const f = withExplainer("maint", "@lgtmoose explain src/a.ts:10", {
        permissions: { maint: "write" },
      });
      await handleConversation(f.deps, job());
      expect(f.added).toMatchObject([{ commentId: 500, kind: "explain_pr" }]);
      expect(f.replies).toEqual([]);
    });

    it("keeps the stored reply for others, closed findings, and with the explainer off", async () => {
      const visitor = withExplainer("visitor", "@lgtmoose explain", {}, { threadRootId: 900 });
      await handleConversation(visitor.deps, inThread);
      expect(visitor.queued).toEqual([]);
      expect(visitor.replies[0]?.body).toContain("The loop skips the last item");
      const closed = withExplainer(
        "author",
        "@lgtmoose explain",
        { status: "fixed" },
        { threadRootId: 900 },
      );
      await handleConversation(closed.deps, inThread);
      expect(closed.queued).toEqual([]);
      expect(closed.replies[0]?.body).toContain("The loop skips the last item");
      const off = withExplainer("author", "@lgtmoose explain", {}, { threadRootId: 900 });
      off.deps.maxExplanations = 0;
      await handleConversation(off.deps, inThread);
      expect(off.added).toEqual([]);
      expect(off.replies[0]?.body).toContain("The loop skips the last item");
    });
  });

  it("ignores a should_fix finding for anyone, the author included", async () => {
    const findings = new Map([[900, finding()]]);
    const f = fakeDeps(from("author", "@lgtmoose ignore", { threadRootId: 900 }), { findings });
    expect(
      await handleConversation(f.deps, job({ kind: "review_comment", commentId: 901 })),
    ).toMatchObject({ ok: true, replied: false });
    expect(f.declined).toEqual(["f-1"]);
  });

  it("doesn't let the PR's author ignore a blocking finding; a maintainer can", async () => {
    const findings = new Map([[900, finding({ severity: "blocking" })]]);
    const author = fakeDeps(from("author", "@lgtmoose ignore", { threadRootId: 900 }), {
      findings,
      permissions: { author: "admin" },
    });
    expect(
      await handleConversation(author.deps, job({ kind: "review_comment", commentId: 901 })),
    ).toMatchObject({ ok: false });
    expect(author.declined).toEqual([]);
    const reader = fakeDeps(from("visitor", "@lgtmoose ignore", { threadRootId: 900 }), {
      findings,
    });
    await handleConversation(reader.deps, job({ kind: "review_comment", commentId: 902 }));
    expect(reader.declined).toEqual([]);
    const maint = fakeDeps(from("maint", "@lgtmoose ignore", { threadRootId: 900 }), {
      findings,
      permissions: { maint: "write" },
    });
    await handleConversation(maint.deps, job({ kind: "review_comment", commentId: 903 }));
    expect(maint.declined).toEqual(["f-1"]);
  });

  it("only ignores in a finding's thread", async () => {
    const f = fakeDeps(from("maint", "@lgtmoose ignore"), { permissions: { maint: "write" } });
    expect(await handleConversation(f.deps, job())).toMatchObject({ ok: false });
    expect(f.replies[0]?.body).toContain("finding");
  });

  it("writes nothing to GitHub in shadow mode, and logs what it would have", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose help"), { shadow: true });
    expect(await handleConversation(f.deps, job())).toMatchObject({ action: "commands" });
    expect(f.reactions).toEqual([]);
    expect(f.replies).toEqual([]);
    expect(f.logs.map((entry) => entry.message)).toContain("shadow: command reply not posted");
  });
});
