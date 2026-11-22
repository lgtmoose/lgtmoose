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
    /** The submitted review is gone (its fetch 404s). */
    reviewGone?: boolean;
    /** The repo config's `review.trusted_bots`; left out, the fake can't read it. */
    trustedBots?: string[];
    /** The App's slug; `lgtmoose` when left out. */
    slug?: string;
  } = {},
) {
  const reviewsRead: number[] = [];
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
        slug: async () => options.slug ?? "lgtmoose",
        comment: async () => comment,
        review: async (_repo, _number, reviewId) => {
          reviewsRead.push(reviewId);
          return options.reviewGone === true ? undefined : comment;
        },
        pull: async () => ({
          headSha: HEAD,
          baseSha: "b".repeat(40),
          author: options.pullAuthor ?? "author",
          open: options.open ?? true,
        }),
        ...(options.trustedBots === undefined
          ? {}
          : {
              trustedBots: async (_repo: string, baseSha: string) => {
                asked.push(`config@${baseSha}`);
                return options.trustedBots ?? [];
              },
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
  return {
    deps,
    reactions,
    replies,
    queued,
    paused,
    declined,
    learnings,
    logs,
    asked,
    reviewsRead,
  };
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

  it("ignores bots and our own replies", async () => {
    const bot = fakeDeps(from("ci[bot]", "@lgtmoose review", { authorIsBot: true }));
    expect(await handleConversation(bot.deps, job())).toMatchObject({ action: "ignored" });
    const ours = fakeDeps(from("dev", `@lgtmoose help\n\n${REPLY_MARKER}`));
    expect(await handleConversation(ours.deps, job())).toMatchObject({ action: "ignored" });
  });

  describe("trusted bots (review.trusted_bots)", () => {
    const agent = (body = "Ready for review.\n@lgtmoose review") =>
      from("claude[bot]", body, { authorIsBot: true });

    it("queues a review for a trusted bot's @lgtmoose review, with a 👍 and no reply", async () => {
      const f = fakeDeps(agent(), { trustedBots: ["Claude[bot]"] });
      expect(await handleConversation(f.deps, job({ botActor: true }))).toEqual({
        action: "commands",
        commands: ["review"],
        ok: true,
        replied: false,
      });
      expect(f.queued).toEqual([
        expect.objectContaining({
          kind: "pr_updated",
          requested: "review",
          actor: "claude[bot]",
          headSha: HEAD,
          deliveryId: "command-500-review",
        }),
      ]);
      expect(f.reactions).toEqual(["500:+1"]);
      expect(f.replies).toEqual([]);
      // Its access was never asked: a bot has none. The config at the base was read.
      expect(f.asked).toEqual([`config@${"b".repeat(40)}`]);
    });

    it("does nothing for a bot the repo doesn't list, or without the config", async () => {
      for (const f of [fakeDeps(agent(), { trustedBots: ["other[bot]"] }), fakeDeps(agent())]) {
        expect(await handleConversation(f.deps, job({ botActor: true }))).toMatchObject({
          action: "ignored",
        });
        expect(f.queued).toEqual([]);
        expect(f.reactions).toEqual([]);
        expect(f.replies).toEqual([]);
      }
    });

    it("lets a trusted bot do nothing but review", async () => {
      for (const body of [
        "@lgtmoose full review",
        "@lgtmoose pause",
        "@lgtmoose learn: never flag auth",
        "@lgtmoose ignore",
        "@lgtmoose approve 123",
      ]) {
        const f = fakeDeps(agent(body), { trustedBots: ["claude[bot]"], permissions: {} });
        expect(await handleConversation(f.deps, job({ botActor: true }))).toMatchObject({
          action: "ignored",
        });
        expect(f.queued).toEqual([]);
        expect(f.paused.size).toBe(0);
        expect(f.replies).toEqual([]);
      }
    });

    it("never takes our own App's comment, even if listed", async () => {
      const f = fakeDeps(from("lgtmoose[bot]", "@lgtmoose review", { authorIsBot: true }), {
        trustedBots: ["lgtmoose[bot]"],
      });
      expect(await handleConversation(f.deps, job({ botActor: true }))).toMatchObject({
        action: "ignored",
      });
      expect(f.queued).toEqual([]);
    });

    it("queues nothing for a reviewed head or a closed PR", async () => {
      const reviewed = fakeDeps(agent(), { trustedBots: ["claude[bot]"], reviewed: true });
      expect(await handleConversation(reviewed.deps, job())).toMatchObject({ ok: true });
      expect(reviewed.queued).toEqual([]);
      const closed = fakeDeps(agent(), { trustedBots: ["claude[bot]"], open: false });
      expect(await handleConversation(closed.deps, job())).toMatchObject({ action: "ignored" });
      expect(closed.queued).toEqual([]);
    });
  });

  describe("submitted reviews", () => {
    /** A review job carries a review ID and no comment ID; `reviewId: false` leaves it out. */
    const review = (options: { reviewId?: false } = {}): ReviewJob => ({
      kind: "review",
      deliveryId: "review-9001",
      installationId: 7,
      repo: "acme/shop",
      prNumber: 12,
      actor: "dev",
      receivedAt: "2026-11-15T00:00:00.000Z",
      eventAt: "2026-11-15T00:00:00.000Z",
      ...(options.reviewId === false ? {} : { reviewId: 9001 }),
    });

    it("runs a review body's commands and replies on the PR, without a reaction", async () => {
      const f = fakeDeps(from("author", "Mostly fine.\n\n@lgtmoose review"));
      expect(await handleConversation(f.deps, review())).toEqual({
        action: "commands",
        commands: ["review"],
        ok: true,
        replied: true,
      });
      expect(f.reviewsRead).toEqual([9001]);
      // GitHub has no reactions API for reviews: the reply on the PR is the only answer.
      expect(f.reactions).toEqual([]);
      expect(f.replies).toEqual([
        { kind: "review", commentId: 9001, body: `@author: Done.\n\n${REPLY_MARKER}` },
      ]);
      // Keyed by the review, so a redelivered review asks for its run once.
      expect(f.queued).toEqual([
        expect.objectContaining({
          kind: "pr_updated",
          requested: "review",
          deliveryId: "command-review-9001-review",
          actor: "author",
        }),
      ]);
      expect(f.queued[0]).not.toHaveProperty("commentId");
    });

    it("applies a comment's rules: writers only for pause, help for unknown commands", async () => {
      const reader = fakeDeps(from("dev", "@lgtmoose pause"));
      expect(await handleConversation(reader.deps, review())).toMatchObject({ ok: false });
      expect(reader.paused.size).toBe(0);
      expect(reader.replies[0]?.body).toMatch(/^@dev: .*write access/);
      const unknown = fakeDeps(from("dev", "@lgtmoose deploy"));
      await handleConversation(unknown.deps, review());
      expect(unknown.replies[0]?.body).toContain("@lgtmoose full review");
    });

    it("answers explain path:line with the stored finding, the explainer on", async () => {
      const f = fakeDeps(from("author", "@lgtmoose explain src/a.ts:10"), {
        findings: new Map([[900, finding()]]),
      });
      const added: unknown[] = [];
      f.deps.replies = {
        add: async (input) => {
          added.push(input);
          return true;
        },
        take: async () => [],
        finish: async () => {},
        failed: async () => {},
      };
      f.deps.maxExplanations = 5;
      expect(await handleConversation(f.deps, review())).toMatchObject({ ok: true });
      expect(added).toEqual([]);
      expect(f.queued).toEqual([]);
      expect(f.replies[0]?.body).toContain("The loop skips the last item");
    });

    it("reads commands outside code and quotes only", async () => {
      const f = fakeDeps(from("dev", "> @lgtmoose pause\n\n```\n@lgtmoose pause\n```"));
      expect(await handleConversation(f.deps, review())).toEqual({
        action: "ignored",
        reason: "no commands in the review",
      });
      expect(f.replies).toEqual([]);
    });

    it("leaves a review without commands alone: review bodies never go to the reply judge", async () => {
      const f = fakeDeps(from("dev", "Please rename this."));
      expect(await handleConversation(f.deps, review())).toEqual({
        action: "ignored",
        reason: "no commands in the review",
      });
      expect(f.queued).toEqual([]);
      expect(f.replies).toEqual([]);
    });

    it("ignores bots, our own reviews, gone reviews and jobs without a review ID", async () => {
      const bot = fakeDeps(from("lgtmoose[bot]", "@lgtmoose pause", { authorIsBot: true }));
      expect(await handleConversation(bot.deps, review())).toEqual({
        action: "ignored",
        reason: "a bot's review",
      });
      const ours = fakeDeps(from("dev", `@lgtmoose help\n\n${REPLY_MARKER}`));
      expect(await handleConversation(ours.deps, review())).toMatchObject({ action: "ignored" });
      const gone = fakeDeps(from("dev", "@lgtmoose help"), { reviewGone: true });
      expect(await handleConversation(gone.deps, review())).toEqual({
        action: "ignored",
        reason: "the review is gone",
      });
      const noId = fakeDeps(from("dev", "@lgtmoose help"));
      expect(await handleConversation(noId.deps, review({ reviewId: false }))).toEqual({
        action: "ignored",
        reason: "no review ID",
      });
      expect([...bot.replies, ...ours.replies, ...gone.replies, ...noId.replies]).toEqual([]);
    });

    it("learns from a review body without recording a comment ID", async () => {
      const f = fakeDeps(from("dev", "@lgtmoose learn: prefer early returns"), {
        permissions: { dev: "write" },
      });
      expect(await handleConversation(f.deps, review())).toMatchObject({ ok: true });
      const [learning] = await f.learnings.list({ org: "acme" });
      expect(learning).toMatchObject({ text: "prefer early returns" });
      expect(learning?.sourceCommentId).toBeUndefined();
    });

    it("says ignore works in a finding's thread only", async () => {
      const f = fakeDeps(from("dev", "@lgtmoose ignore"));
      await handleConversation(f.deps, review());
      expect(f.replies[0]?.body).toContain("`ignore` works as a reply");
    });

    it("writes nothing to GitHub in shadow mode", async () => {
      const f = fakeDeps(from("dev", "@lgtmoose help"), { shadow: true });
      expect(await handleConversation(f.deps, review())).toMatchObject({ action: "commands" });
      expect(f.replies).toEqual([]);
      expect(f.logs).toEqual([
        expect.objectContaining({
          message: "shadow: command reply not posted",
          fields: expect.objectContaining({ reviewId: 9001 }),
        }),
      ]);
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

  it("hands a finding `ignore` declined to outcome learning (NIC-1081)", async () => {
    const findings = new Map([[900, finding()]]);
    const f = fakeDeps(from("author", "@lgtmoose ignore", { threadRootId: 900 }), { findings });
    const rejected: unknown[] = [];
    f.deps.outcomes = {
      async rejected(installationId, repo, entries) {
        rejected.push({ installationId, repo, entries });
      },
    };
    await handleConversation(f.deps, job({ kind: "review_comment", commentId: 901 }));
    expect(rejected).toEqual([
      { installationId: 7, repo: "acme/shop", entries: [{ findingId: "f-1", commentId: 901 }] },
    ]);
  });

  describe("remember (NIC-1081)", () => {
    const declined = (overrides: Partial<StoredFinding> = {}) =>
      new Map([[900, finding({ status: "declined", ruleCategory: "style", ...overrides })]]);
    const remember = (
      author: string,
      findings: Map<number, StoredFinding>,
      options: Parameters<typeof fakeDeps>[1] = {},
    ) => {
      const f = fakeDeps(from(author, "@lgtmoose remember", { threadRootId: 900 }), {
        findings,
        ...options,
      });
      f.deps.store.declineReason = async () => ({
        author: "maint",
        body: "Default exports are how we do pages.",
      });
      return f;
    };

    it("learns not to raise findings like a declined one, active with write access", async () => {
      const f = remember("maint", declined(), { permissions: { maint: "write" } });
      expect(
        await handleConversation(f.deps, job({ kind: "review_comment", commentId: 950 })),
      ).toMatchObject({ ok: true, replied: true });
      const [learning] = f.learnings.all();
      expect(learning).toMatchObject({
        kind: "scoping",
        category: "style",
        repo: "acme/shop",
        status: "active",
        author: "maint",
        sourceCommentId: 950,
      });
      expect(learning?.patternKey).toMatch(/^style:/);
      expect(learning?.text).toContain("Default exports are how we do pages.");
      expect(f.replies[0]?.body).toContain("is active");
    });

    it("leaves one by someone without write access pending", async () => {
      const f = remember("visitor", declined());
      await handleConversation(f.deps, job({ kind: "review_comment", commentId: 951 }));
      expect(f.learnings.all()).toMatchObject([{ status: "pending" }]);
      expect(f.replies[0]?.body).toContain("pending");
    });

    it("refuses a protected category, and a finding that wasn't declined", async () => {
      const authz = remember("maint", declined({ ruleCategory: "authz" }), {
        permissions: { maint: "admin" },
      });
      await handleConversation(authz.deps, job({ kind: "review_comment", commentId: 952 }));
      expect(authz.learnings.all()).toEqual([]);
      expect(authz.replies[0]?.body).toContain("Not remembered");

      const open = remember("maint", new Map([[900, finding()]]), {
        permissions: { maint: "write" },
      });
      await handleConversation(open.deps, job({ kind: "review_comment", commentId: 953 }));
      expect(open.learnings.all()).toEqual([]);
      expect(open.replies[0]?.body).toContain("Decline it first");
    });

    it("never takes `remember` from a bot, trusted or not", async () => {
      const f = fakeDeps(
        from("claude[bot]", "@lgtmoose remember", { threadRootId: 900, authorIsBot: true }),
        {
          findings: declined(),
          trustedBots: ["claude[bot]"],
          permissions: { "claude[bot]": "write" },
        },
      );
      expect(
        await handleConversation(f.deps, job({ kind: "review_comment", commentId: 954 })),
      ).toMatchObject({ action: "ignored" });
      expect(f.learnings.all()).toEqual([]);
    });
  });

  it("writes nothing to GitHub in shadow mode, and logs what it would have", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose help"), { shadow: true });
    expect(await handleConversation(f.deps, job())).toMatchObject({ action: "commands" });
    expect(f.reactions).toEqual([]);
    expect(f.replies).toEqual([]);
    expect(f.logs.map((entry) => entry.message)).toContain("shadow: command reply not posted");
  });
});

describe("command handles (NIC-1119)", () => {
  const SLUG = "lgtmoose-acme";
  /**
   * A store that records the hint once per PR, as the drizzle store does: a claim holds until
   * it's posted, and its own claimant's retry may claim it again once the claim is two minutes
   * old. `advance` moves its clock. (Stale claims, after 15 minutes, are the PGlite tests'.)
   */
  function withHintStore(f: ReturnType<typeof fakeDeps>) {
    let clock = 0;
    const claimed = new Map<string, { claimant: string; posted: boolean; at: number }>();
    f.deps.store.claimHandleHint = async (repo, number, claimant) => {
      const key = `${repo}#${number}`;
      const held = claimed.get(key);
      if (held !== undefined) {
        const mine = held.claimant === claimant;
        if (held.posted) return mine ? "mine-posted" : "other";
        if (!mine) return "other";
        if (clock - held.at < 2 * 60_000) return "mine-pending";
      }
      claimed.set(key, { claimant, posted: false, at: clock });
      return "claimed";
    };
    f.deps.store.handleHintPosted = async (repo, number) => {
      const held = claimed.get(`${repo}#${number}`);
      if (held !== undefined) held.posted = true;
    };
    return Object.assign(claimed, {
      advance(ms: number) {
        clock += ms;
      },
    });
  }

  it("runs a command addressed to the App's own handle", async () => {
    const f = fakeDeps(from("author", `@${SLUG} review`), { slug: SLUG });
    expect(await handleConversation(f.deps, job())).toMatchObject({ commands: ["review"] });
    expect(f.queued).toHaveLength(1);
  });

  it("runs a command addressed to an alias, with the same permission checks", async () => {
    const f = fakeDeps(from("outsider", "@lgtmoose pause"), { slug: SLUG });
    f.deps.commandAliases = ["lgtmoose"];
    withHintStore(f);
    expect(await handleConversation(f.deps, job())).toMatchObject({
      commands: ["pause"],
      ok: false,
    });
    // An alias asks for nothing a person couldn't ask for with the real handle.
    expect(f.paused.size).toBe(0);
    expect(f.replies[0]?.body).toContain("needs write access");
    const maintainer = fakeDeps(from("lead", "@lgtmoose pause"), {
      slug: SLUG,
      permissions: { lead: "write" },
    });
    maintainer.deps.commandAliases = ["lgtmoose"];
    expect(await handleConversation(maintainer.deps, job())).toMatchObject({ ok: true });
    expect(maintainer.paused.get("acme/shop#12")).toBe("lead");
  });

  it("answers help with the real handle, whichever handle was used", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose help"), { slug: SLUG });
    f.deps.commandAliases = ["lgtmoose"];
    await handleConversation(f.deps, job());
    expect(f.replies[0]?.body).toContain(`\`@${SLUG} review\``);
    expect(f.replies[0]?.body).not.toContain("`@lgtmoose review`");
  });

  it("hints the real handle once per PR when @lgtmoose isn't an alias", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose full review"), { slug: SLUG });
    withHintStore(f);
    expect(await handleConversation(f.deps, job())).toMatchObject({ action: "ignored" });
    expect(f.queued).toEqual([]);
    expect(f.replies).toHaveLength(1);
    expect(f.replies[0]?.body).toContain(`Commands here use \`@${SLUG}\``);
    expect(f.replies[0]?.body).toContain(REPLY_MARKER);
    // A second one on the same PR gets no second hint, only a 😕 saying it did nothing.
    await handleConversation(f.deps, job({ commentId: 501, deliveryId: "d-2" }));
    expect(f.replies).toHaveLength(1);
    expect(f.reactions).toEqual(["501:confused"]);
  });

  it("sends a wrong-handle comment down the normal path without a store that records hints", async () => {
    const f = inThread("@lgtmoose ignore");
    expect(await handleConversation(f.deps, threadReply)).toMatchObject({ action: "reply" });
    expect(f.added).toEqual(["@lgtmoose ignore"]);
    expect(f.replies).toEqual([]);
  });

  it("gives no hint for an alias, a plain mention, an unknown word or the right handle", async () => {
    const cases: [string, string[]][] = [
      ["@lgtmoose review", ["lgtmoose"]],
      ["Thanks @lgtmoose", []],
      ["@lgtmoose what do you think about tabs?", []],
      [`@${SLUG} review`, []],
      ["`@lgtmoose review` in code", []],
    ];
    for (const [body, aliases] of cases) {
      const f = fakeDeps(from("dev", body), { slug: SLUG });
      f.deps.commandAliases = aliases;
      withHintStore(f);
      await handleConversation(f.deps, job());
      expect(f.replies.filter((reply) => reply.body.includes("Commands here use"))).toEqual([]);
    }
  });

  /** A wrong-handle command in one of our findings' threads, with a reply store to watch. */
  function inThread(body: string) {
    const f = fakeDeps(from("dev", body, { threadRootId: 100 }), {
      slug: SLUG,
      findings: new Map([[100, finding()]]),
    });
    const added: string[] = [];
    f.deps.replies = {
      add: async (input) => {
        added.push(input.body);
        return true;
      },
      take: async () => [],
      finish: async () => {},
      failed: async () => {},
    };
    return { ...f, added };
  }
  const threadReply = job({ kind: "review_comment", commentId: 501 });

  it("still sends a wrong-handle command in a finding's thread to the reply judge, with the hint", async () => {
    const f = inThread("@lgtmoose ignore");
    withHintStore(f);
    expect(await handleConversation(f.deps, threadReply)).toMatchObject({
      action: "reply",
      queued: true,
    });
    // The judge reads it: the person may be answering the finding.
    expect(f.added).toEqual(["@lgtmoose ignore"]);
    // It isn't run as a command.
    expect(f.declined).toEqual([]);
    expect(f.replies[0]?.body).toContain("Commands here use");
  });

  it("leaves a sentence that starts with a command word to the normal path", async () => {
    // Top level: not a command, so no hint and nothing diverted.
    for (const body of [
      "@lgtmoose help me see why this is null here",
      "cc @lgtmoose: review of this is in #12",
    ]) {
      const f = fakeDeps(from("dev", body), { slug: SLUG });
      withHintStore(f);
      expect(await handleConversation(f.deps, job())).toMatchObject({ action: "deferred" });
      expect(f.replies).toEqual([]);
      expect(f.reactions).toEqual([]);
    }
    // In a finding's thread, the judge reads it.
    const thread = inThread("@lgtmoose help me see why this is null here");
    withHintStore(thread);
    expect(await handleConversation(thread.deps, threadReply)).toMatchObject({ action: "reply" });
    expect(thread.added).toHaveLength(1);
    expect(thread.replies).toEqual([]);
  });

  it("posts the hint on a retry of the comment whose claim was never posted", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose review"), { slug: SLUG });
    const store = withHintStore(f);
    // An earlier delivery of comment 500 claimed it, then its Lambda died before posting.
    expect(await f.deps.store.claimHandleHint?.("acme/shop", 12, "500")).toBe("claimed");
    // Another comment can't take it meanwhile, and gets a 😕.
    await handleConversation(f.deps, job({ commentId: 600, deliveryId: "d-6" }));
    expect(f.replies).toEqual([]);
    expect(f.reactions).toEqual(["600:confused"]);
    // An overlapping delivery of comment 500 waits for the first: no hint, and no 😕.
    await handleConversation(f.deps, job());
    expect(f.replies).toEqual([]);
    expect(f.reactions).toEqual(["600:confused"]);
    // Once no attempt can still be posting, the retry of comment 500 posts it.
    store.advance(3 * 60_000);
    await handleConversation(f.deps, job());
    expect(f.replies).toHaveLength(1);
    expect(f.replies[0]).toMatchObject({ commentId: 500 });
  });

  it("gives no 😕 to a retry of the comment that got the hint, after a later step failed", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose review", { createdAt: "2026-11-15T00:00:03.000Z" }), {
      slug: SLUG,
    });
    withHintStore(f);
    let fail = true;
    f.deps.store.commentsThrough = async () => {
      if (fail) throw new Error("database gone");
    };
    // The hint is posted, then marking the comment handled throws: the job is retried.
    await expect(handleConversation(f.deps, job())).rejects.toThrow("database gone");
    expect(f.replies).toHaveLength(1);
    fail = false;
    expect(await handleConversation(f.deps, job())).toMatchObject({ action: "ignored" });
    expect(f.replies).toHaveLength(1);
    expect(f.reactions).toEqual([]);
  });

  it("logs a 😕 that can't be posted, and still marks the comment handled", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose review", { createdAt: "2026-11-15T00:00:03.000Z" }), {
      slug: SLUG,
    });
    withHintStore(f);
    const through: Date[] = [];
    f.deps.store.commentsThrough = async (_repo, _number, at) => {
      through.push(at);
    };
    await f.deps.store.claimHandleHint?.("acme/shop", 12, "999");
    const github = await f.deps.github(7);
    f.deps.github = async () => ({
      ...github,
      react: async () => {
        throw new Error("HTTP 404: comment deleted");
      },
    });
    expect(await handleConversation(f.deps, job())).toMatchObject({ action: "ignored" });
    expect(f.logs.map((entry) => entry.message)).toContain("wrong-handle reaction not posted");
    expect(through).toHaveLength(1);
  });

  it("logs a wrong-handle review body after the hint: reviews take no reactions", async () => {
    const f = fakeDeps(from("author", "@lgtmoose review"), { slug: SLUG });
    withHintStore(f);
    await f.deps.store.claimHandleHint?.("acme/shop", 12, "500");
    await f.deps.store.handleHintPosted?.("acme/shop", 12);
    const review: ReviewJob = {
      kind: "review",
      deliveryId: "review-9001",
      installationId: 7,
      repo: "acme/shop",
      prNumber: 12,
      actor: "author",
      reviewId: 9001,
      receivedAt: "2026-11-15T00:00:00.000Z",
      eventAt: "2026-11-15T00:00:00.000Z",
    };
    expect(await handleConversation(f.deps, review)).toMatchObject({ action: "ignored" });
    expect(f.replies).toEqual([]);
    expect(f.logs.map((entry) => entry.message)).toContain("wrong-handle review after the hint");
  });

  it("with commandHint off, gives no hint and treats the comment as before", async () => {
    const f = inThread("@lgtmoose ignore, it's fine");
    f.deps.commandHint = false;
    withHintStore(f);
    expect(await handleConversation(f.deps, threadReply)).toMatchObject({ action: "reply" });
    expect(f.added).toEqual(["@lgtmoose ignore, it's fine"]);
    expect(f.replies).toEqual([]);
  });

  it("logs a hint that fails to post, and gives the PR's claim back", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose review"), { slug: SLUG });
    const claimed = withHintStore(f);
    const released: string[] = [];
    f.deps.store.releaseHandleHint = async (repo, number) => {
      released.push(`${repo}#${number}`);
      claimed.delete(`${repo}#${number}`);
    };
    const github = await f.deps.github(7);
    f.deps.github = async () => ({
      ...github,
      reply: async () => {
        throw new Error("HTTP 403: conversation locked");
      },
    });
    // The job carries on: nothing is thrown.
    expect(await handleConversation(f.deps, job())).toMatchObject({ action: "ignored" });
    expect(released).toEqual(["acme/shop#12"]);
    expect(f.logs.map((entry) => entry.message)).toContain("handle hint not posted");
    // A later comment can still get it.
    expect(claimed.size).toBe(0);
  });

  it("gives no hint when the App is itself called lgtmoose", async () => {
    const f = fakeDeps(from("dev", "Thanks @lgtmoose-fan"));
    withHintStore(f);
    await handleConversation(f.deps, job());
    expect(f.replies).toEqual([]);
  });

  it("logs the hint in shadow mode, without posting or using it up", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose review"), { slug: SLUG, shadow: true });
    const claimed = withHintStore(f);
    await handleConversation(f.deps, job());
    expect(f.replies).toEqual([]);
    expect(f.reactions).toEqual([]);
    expect(claimed.size).toBe(0);
    expect(f.logs.map((entry) => entry.message)).toContain("shadow: handle hint not posted");
  });

  it("gives no hint without a store that records it", async () => {
    const f = fakeDeps(from("dev", "@lgtmoose review"), { slug: SLUG });
    await handleConversation(f.deps, job());
    expect(f.replies).toEqual([]);
  });

  it("records a posted hint, and gives a thanks or a cc no hint", async () => {
    const posted: string[] = [];
    const f = fakeDeps(from("dev", "@lgtmoose review"), { slug: SLUG });
    withHintStore(f);
    f.deps.store.handleHintPosted = async (repo, number) => {
      posted.push(`${repo}#${number}`);
    };
    await handleConversation(f.deps, job());
    expect(posted).toEqual(["acme/shop#12"]);
    for (const body of ["Thanks @lgtmoose!", "Good catch @lgtmoose.", "cc @lgtmoose"]) {
      const thanks = fakeDeps(from("dev", body), { slug: SLUG });
      withHintStore(thanks);
      await handleConversation(thanks.deps, job());
      expect(thanks.replies).toEqual([]);
      expect(thanks.reactions).toEqual([]);
    }
  });

  it("hints in a submitted review's body too, addressed to its author", async () => {
    const f = fakeDeps(from("author", "LGTM\n\n@lgtmoose review"), { slug: SLUG });
    withHintStore(f);
    const review: ReviewJob = {
      kind: "review",
      deliveryId: "review-9001",
      installationId: 7,
      repo: "acme/shop",
      prNumber: 12,
      actor: "author",
      reviewId: 9001,
      receivedAt: "2026-11-15T00:00:00.000Z",
      eventAt: "2026-11-15T00:00:00.000Z",
    };
    expect(await handleConversation(f.deps, review)).toMatchObject({ action: "ignored" });
    expect(f.replies).toEqual([
      expect.objectContaining({
        kind: "review",
        commentId: 9001,
        body: expect.stringMatching(/^@author: Commands here use `@lgtmoose-acme`/),
      }),
    ]);
  });

  it("takes a trusted bot's review request addressed to an alias", async () => {
    const f = fakeDeps(from("claude[bot]", "@lgtmoose review", { authorIsBot: true }), {
      slug: SLUG,
      trustedBots: ["claude[bot]"],
    });
    f.deps.commandAliases = ["lgtmoose"];
    expect(await handleConversation(f.deps, job({ botActor: true }))).toMatchObject({
      commands: ["review"],
      ok: true,
    });
    expect(f.queued).toHaveLength(1);
    // Without the alias, the same comment asks for nothing, and a bot gets no hint.
    const plain = fakeDeps(from("claude[bot]", "@lgtmoose review", { authorIsBot: true }), {
      slug: SLUG,
      trustedBots: ["claude[bot]"],
    });
    withHintStore(plain);
    expect(await handleConversation(plain.deps, job({ botActor: true }))).toMatchObject({
      action: "ignored",
    });
    expect(plain.queued).toEqual([]);
    expect(plain.replies).toEqual([]);
  });
});
