import type { Judgement } from "@lgtmoose/core";
import { describe, expect, it } from "vitest";
import {
  confirmFixes,
  replyWritesSchema,
  settleReplies,
  writeReplies,
  type JudgedReply,
  type ReplyWrites,
  type SettleDeps,
} from "./judged-replies.js";
import { JUDGE_REPLY_MARKER } from "./replies.js";

const reply = (overrides: Partial<JudgedReply> = {}): JudgedReply => ({
  index: 3,
  replyId: "r1",
  findingId: "f1",
  commentId: 501,
  author: "dev",
  fileChanged: true,
  ...overrides,
});

function settleDeps(judgements: Record<number, Judgement | undefined>) {
  const closed: { id: string; status: string }[] = [];
  const deps: SettleDeps = {
    judgement: async (index) => judgements[index],
    findings: [
      {
        id: "f1",
        severity: "should_fix",
        ruleCategory: "bug",
        path: "a.ts",
        status: "open",
        fingerprint: "p1",
        githubCommentId: 100,
      },
      {
        id: "f2",
        severity: "blocking",
        ruleCategory: "bug",
        path: "b.ts",
        status: "open",
        fingerprint: "p2",
        githubCommentId: 200,
      },
    ],
    threadId: (root) => `thread-${root}`,
    prAuthor: "dev",
    permission: async () => "write",
    close: async (id, status) => {
      closed.push({ id, status });
      return true;
    },
    disputesAnswered: async () => new Set(),
    log: () => {},
  };
  return { deps, closed };
}

describe("settleReplies", () => {
  it("closes what the policy allows, holds fixes for the review, and lists the writes", async () => {
    const { deps, closed } = settleDeps({
      3: { kind: "fixed", fixed_at_head: true },
      4: { kind: "declined" },
      5: { kind: "question", text: "Because it retries." },
    });
    const { writes, fixes } = await settleReplies(
      [
        reply(),
        // The PR's author can't decline a blocking finding: held, with one reply.
        reply({ index: 4, replyId: "r2", findingId: "f2", commentId: 502 }),
        reply({ index: 5, replyId: "r3", findingId: "f1", commentId: 503 }),
        // Its finding isn't open any more.
        reply({ index: 6, replyId: "r4", findingId: "gone", commentId: 504 }),
      ],
      deps,
    );
    // The fix isn't closed yet: the run's review decides (`confirmFixes`).
    expect(closed).toEqual([]);
    expect(fixes).toEqual([
      {
        findingId: "f1",
        fingerprint: "p1",
        path: "a.ts",
        commentId: 501,
        author: "dev",
        threadRootId: 100,
        threadId: "thread-100",
      },
    ]);
    expect(writes.closed).toBe(0);
    expect(writes.skipped).toEqual(["r4"]);
    expect(writes.judged).toEqual(["r1", "r2", "r3"]);
    expect(writes.writes).toMatchObject([
      { findingId: "f2", threadRootId: 200, replyEvent: "replied" },
      { findingId: "f1", threadRootId: 100, replyEvent: "replied" },
    ]);
    expect(writes.writes[0]?.threadId).toBeUndefined();
    expect(replyWritesSchema.parse(JSON.parse(JSON.stringify(writes)))).toEqual(writes);
  });

  it("lists the findings it rejected, and offers `remember` on a plain decline (NIC-1081)", async () => {
    const { deps } = settleDeps({ 3: { kind: "declined" } });
    const { writes } = await settleReplies([reply()], { ...deps, slug: "lgtmoose" });
    expect(writes.rejected).toEqual([{ findingId: "f1", commentId: 501 }]);
    expect(writes.writes).toMatchObject([
      { findingId: "f1", threadRootId: 100, threadId: "thread-100", replyEvent: "replied" },
    ]);
    expect(writes.writes[0]?.reply).toContain("`@lgtmoose remember`");
    expect(replyWritesSchema.parse(JSON.parse(JSON.stringify(writes)))).toEqual(writes);
  });

  it("counts a failed judge as an attempt and writes nothing for it", async () => {
    const { deps, closed } = settleDeps({});
    const { writes } = await settleReplies([reply()], deps);
    expect(writes).toMatchObject({ failed: ["r1"], judged: [], writes: [], closed: 0 });
    expect(closed).toEqual([]);
  });
});

describe("confirmFixes", () => {
  const fix = (findingId: string, fingerprint: string, path: string) => ({
    findingId,
    fingerprint,
    path,
    commentId: 501,
    author: "dev",
    threadRootId: 100,
    threadId: `thread-${findingId}`,
  });
  const empty = () => ({
    version: 1 as const,
    judged: [],
    failed: [],
    skipped: [],
    writes: [],
    closed: 0,
  });

  it("closes a fix only when the run reviewed its file and didn't raise it again", async () => {
    const closed: string[] = [];
    const writes = empty();
    const ids = await confirmFixes(
      [fix("ok", "p1", "a.ts"), fix("again", "p2", "a.ts"), fix("unread", "p3", "b.ts")],
      { reraised: ["p2"], reviewedNow: ["a.ts"] },
      writes,
      async (id) => {
        closed.push(id);
        return true;
      },
    );
    expect(ids).toEqual(["ok"]);
    expect(closed).toEqual(["ok"]);
    expect(writes.closed).toBe(1);
    // What outcome learning reinforces (NIC-1081): only the fix that held up.
    expect((writes as ReplyWrites).fixed).toEqual([{ findingId: "ok", commentId: 501 }]);
    expect(writes.writes).toMatchObject([
      { findingId: "ok", threadId: "thread-ok" },
      { findingId: "again", reply: expect.stringContaining("found this again") },
      { findingId: "unread", reply: expect.stringContaining("wasn't reviewed again") },
    ]);
  });
});

describe("writeReplies", () => {
  it("resolves, replies with our marker, records the reply and marks the replies", async () => {
    const calls: string[] = [];
    const marked: Record<string, string[]> = {};
    const replied = await writeReplies(
      {
        version: 1,
        judged: ["r1"],
        failed: ["r2"],
        skipped: ["r3"],
        closed: 1,
        writes: [
          { findingId: "f1", threadId: "t1", threadRootId: 100, commentId: 501, author: "dev" },
          {
            findingId: "f2",
            threadRootId: 200,
            reply: "Still here.",
            replyEvent: "dispute_answered",
            commentId: 502,
            author: "dev",
            learning: "We allow this in scripts.",
          },
        ],
      },
      {
        reply: async (root, body) => {
          calls.push(`reply ${root}`);
          expect(body).toContain(JUDGE_REPLY_MARKER);
        },
        resolveThread: async (id) => {
          calls.push(`resolve ${id}`);
          throw new Error("GraphQL down");
        },
        recordReply: async (id, type) => {
          calls.push(`record ${id} ${type}`);
        },
        proposeLearning: async (write) => {
          calls.push(`learn ${write.learning}`);
        },
        replies: {
          finish: async (ids, status) => {
            marked[status] = [...ids];
          },
          failed: async (ids) => {
            marked.failed = [...ids];
          },
        },
        log: () => {},
      },
    );
    expect(replied).toBe(1);
    expect(calls).toEqual([
      "resolve t1",
      "reply 200",
      "record f2 dispute_answered",
      "learn We allow this in scripts.",
    ]);
    expect(marked).toEqual({ judged: ["r1"], skipped: ["r3"], failed: ["r2"] });
  });
});
