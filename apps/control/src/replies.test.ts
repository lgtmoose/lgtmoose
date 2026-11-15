import type { Judgement } from "@lgtmoose/core";
import { describe, expect, it } from "vitest";
import { decideReply, isTrivialReply, type ReplyContext } from "./replies.js";
import type { Permission } from "./thread-policy.js";

function context(overrides: Partial<ReplyContext> = {}, access: Permission = "none"): ReplyContext {
  return {
    finding: { severity: "should_fix", ruleCategory: "bug", path: "src/a.ts", status: "open" },
    author: "dev",
    prAuthor: "dev",
    fileChanged: true,
    disputeAnswered: false,
    permission: async () => access,
    ...overrides,
  };
}

const blocking = {
  severity: "blocking" as const,
  ruleCategory: "bug",
  path: "src/a.ts",
  status: "open",
};
const judged = (judgement: Judgement) => judgement;

describe("decideReply", () => {
  it("does nothing without a judgement, or for a closed finding", async () => {
    expect(await decideReply(undefined, context())).toMatchObject({ resolveThread: false });
    const closed = context({ finding: { ...blocking, status: "declined" } });
    expect(await decideReply({ kind: "fixed", fixed_at_head: true }, closed)).toEqual({
      resolveThread: false,
      reason: "the finding is already declined",
    });
  });

  it("closes a fix the judge saw at head, once the file changed", async () => {
    expect(await decideReply({ kind: "fixed", fixed_at_head: true }, context())).toMatchObject({
      status: "fixed",
      resolveThread: true,
    });
    // A blocking one too: the code check, not who says it.
    expect(
      await decideReply({ kind: "fixed", fixed_at_head: true }, context({ finding: blocking })),
    ).toMatchObject({ status: "fixed", resolveThread: true });
  });

  it("never closes a claimed fix when the file hasn't changed", async () => {
    const action = await decideReply(
      { kind: "fixed", fixed_at_head: true },
      context({ finding: blocking, fileChanged: false }),
    );
    expect(action.status).toBeUndefined();
    expect(action.resolveThread).toBe(false);
    expect(action.reply).toContain("hasn't changed since this was raised");
  });

  it("replies once with the line when it isn't fixed", async () => {
    const action = await decideReply(
      judged({
        kind: "fixed",
        fixed_at_head: false,
        line: 12,
        text: "The check is still missing.",
      }),
      context(),
    );
    expect(action.status).toBeUndefined();
    expect(action.reply).toContain("line 12");
    // Escaped like all model text: Markdown punctuation is backslashed.
    expect(action.reply).toContain("The check is still missing\\.");
    expect(action.replyEvent).toBe("replied");
  });

  it("accepts a decline of a should_fix from anyone, the author included", async () => {
    expect(
      await decideReply({ kind: "declined", learning: "We log at debug here." }, context()),
    ).toMatchObject({ status: "declined", resolveThread: true, learning: "We log at debug here." });
  });

  it("offers `remember` on a decline with no rule in it, never for a protected category", async () => {
    const offered = await decideReply({ kind: "declined" }, context({ slug: "lgtmoose" }));
    expect(offered).toMatchObject({
      status: "declined",
      resolveThread: true,
      replyEvent: "replied",
    });
    expect(offered.reply).toContain("`@lgtmoose remember`");
    // A rule in the reason is proposed instead: nothing to offer.
    expect(
      (
        await decideReply(
          { kind: "declined", learning: "We log at debug here." },
          context({ slug: "lgtmoose" }),
        )
      ).reply,
    ).toBeUndefined();
    // A protected finding, declined by a maintainer who isn't the PR's author: declined, no offer.
    const authz = context(
      {
        slug: "lgtmoose",
        author: "maint",
        finding: {
          severity: "should_fix",
          ruleCategory: "authz",
          path: "src/a.ts",
          status: "open",
        },
      },
      "write",
    );
    const protectedDecline = await decideReply({ kind: "declined" }, authz);
    expect(protectedDecline.status).toBe("declined");
    expect(protectedDecline.reply).toBeUndefined();
    // Without the slug (it couldn't be read), no offer.
    expect((await decideReply({ kind: "declined" }, context())).reply).toBeUndefined();
  });

  it("holds a decline of a blocking finding by the PR's author", async () => {
    const action = await decideReply({ kind: "declined" }, context({ finding: blocking }, "admin"));
    expect(action.status).toBeUndefined();
    expect(action.reply).toContain("author can't decline it");
  });

  it("holds a decline of a blocking finding by someone without write access", async () => {
    const action = await decideReply(
      { kind: "declined" },
      context({ finding: blocking, author: "visitor" }, "read"),
    );
    expect(action.status).toBeUndefined();
    expect(action.reply).toContain("only someone with write access");
  });

  it("accepts a decline of a blocking finding by a maintainer who isn't the author", async () => {
    expect(
      await decideReply(
        { kind: "declined" },
        context({ finding: blocking, author: "lead" }, "maintain"),
      ),
    ).toMatchObject({ status: "declined", resolveThread: true });
  });

  it("closes a should_fix the judge found wrong on a dispute", async () => {
    expect(
      await decideReply({ kind: "disputed", still_valid: false, text: "It's guarded." }, context()),
    ).toMatchObject({ status: "disputed", resolveThread: true });
  });

  it("keeps a blocking finding open on a dispute, whatever the judge says", async () => {
    const action = await decideReply(
      { kind: "disputed", still_valid: false, text: "It's guarded." },
      context({ finding: blocking, author: "lead" }, "admin"),
    );
    expect(action.status).toBeUndefined();
    expect(action.reply).toContain("may be wrong");
    expect(action.replyEvent).toBe("dispute_answered");
  });

  it("answers a dispute with the evidence once, and never twice", async () => {
    const first = await decideReply(
      { kind: "disputed", still_valid: true, line: 4, text: "x is null on the retry path." },
      context(),
    );
    expect(first.reply).toContain("still applies");
    expect(first.replyEvent).toBe("dispute_answered");
    const second = await decideReply(
      { kind: "disputed", still_valid: true, text: "Again." },
      context({ disputeAnswered: true }),
    );
    expect(second.reply).toBeUndefined();
  });

  it("answers a question, escaping the text", async () => {
    const action = await decideReply(
      { kind: "question", text: "It runs on every retry. See @someone and https://x.example." },
      context(),
    );
    expect(action.reply).toBeDefined();
    expect(action.reply).not.toContain("@someone");
    expect(action.reply).not.toMatch(/https:\/\/x/);
  });

  it("does nothing for other replies or an empty answer", async () => {
    expect((await decideReply({ kind: "other" }, context())).reply).toBeUndefined();
    expect((await decideReply({ kind: "question", text: " " }, context())).reply).toBeUndefined();
  });
});

describe("isTrivialReply", () => {
  it("skips thanks and emoji", () => {
    for (const body of ["thanks!", "Thank you", "👍", "ok.", "+1", "LGTM", "  "]) {
      expect(isTrivialReply(body), body).toBe(true);
    }
  });

  it("keeps anything that says something, including a claimed fix", () => {
    for (const body of ["done", "fixed", "Why is this a problem?", "This is intended."]) {
      expect(isTrivialReply(body), body).toBe(false);
    }
  });
});
