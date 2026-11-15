import { FEEDBACK_REPORT_KEY } from "@lgtmoose/config";
import { feedbackReportSchema, type CategoryStatusCount } from "@lgtmoose/core";
import { describe, expect, it } from "vitest";
import {
  collectFeedback,
  type CommentReaction,
  type FeedbackComment,
  type FeedbackDeps,
} from "./feedback.js";

function fakes(options: {
  comments?: FeedbackComment[];
  reactions?: Record<number, CommentReaction[] | "gone">;
  counts?: CategoryStatusCount[];
  failReactions?: boolean;
}) {
  const replaced = new Map<string, Map<string, string>>();
  const reports: { key: string; body: string }[] = [];
  const logs: string[] = [];
  let limit = -1;
  const deps: FeedbackDeps = {
    store: {
      async commentsToRead(_since, max) {
        limit = max;
        return (options.comments ?? []).slice(0, max);
      },
      async replaceReactions(findingId, reactions) {
        replaced.set(findingId, new Map(reactions));
      },
      async categoryCounts() {
        return options.counts ?? [];
      },
      async declinedFindings() {
        return [];
      },
    },
    github: {
      async reactions(_installation, _repo, commentId) {
        if (options.failReactions === true) throw new Error("GitHub is down");
        return options.reactions?.[commentId] ?? [];
      },
    },
    async putReport(key, body) {
      reports.push({ key, body });
    },
    log: (message) => logs.push(message),
    now: () => new Date("2026-06-01T00:00:00Z"),
    maxComments: 2,
    minSamples: 2,
  };
  return { deps, replaced, reports, logs, limit: () => limit };
}

const comment = (findingId: string, commentId: number): FeedbackComment => ({
  findingId,
  installationId: 1,
  repo: "acme/shop",
  commentId,
});

describe("collectFeedback: outcome learning (NIC-1081)", () => {
  it("hands a comment whose reactions came out against it to outcome learning", async () => {
    const at = "2026-05-01T00:00:00Z";
    const { deps } = fakes({
      comments: [comment("f1", 1), comment("f2", 2)],
      reactions: {
        1: [
          { content: "-1", user: "ada", userIsBot: false, createdAt: at },
          { content: "-1", user: "bob", userIsBot: false, createdAt: at },
          { content: "+1", user: "cy", userIsBot: false, createdAt: at },
        ],
        2: [{ content: "+1", user: "ada", userIsBot: false, createdAt: at }],
      },
    });
    const rejected: string[] = [];
    const counts = await collectFeedback({
      ...deps,
      onRejected: async (entry) => {
        rejected.push(entry.findingId);
        if (entry.findingId === "f1") throw new Error("GitHub is down");
      },
    });
    expect(rejected).toEqual(["f1"]);
    // A failure is counted, never thrown.
    expect(counts.errors).toBe(1);
    expect(counts.feedbackCommentsRead).toBe(2);
  });
});

describe("collectFeedback", () => {
  it("records each person's latest reaction, bots left out, up to the cap", async () => {
    const at = (day: number) => `2026-05-0${day}T00:00:00Z`;
    const { deps, replaced, limit } = fakes({
      comments: [comment("f1", 1), comment("f2", 2), comment("f3", 3)],
      reactions: {
        1: [
          { content: "+1", user: "ada", userIsBot: false, createdAt: at(1) },
          { content: "-1", user: "ada", userIsBot: false, createdAt: at(2) },
          { content: "+1", user: "dependabot[bot]", userIsBot: true, createdAt: at(1) },
          { content: "rocket", user: "bob", userIsBot: false, createdAt: at(1) },
        ],
        2: "gone",
      },
    });
    const counts = await collectFeedback(deps);
    expect(limit()).toBe(2);
    expect(counts.feedbackCommentsRead).toBe(2);
    expect([...(replaced.get("f1") ?? [])]).toEqual([["ada", "-1"]]);
    // A deleted comment keeps no reactions.
    expect(replaced.get("f2")?.size).toBe(0);
    expect(replaced.has("f3")).toBe(false);
  });

  it("writes a valid report and logs flagged categories, protected ones too", async () => {
    const { deps, reports, logs } = fakes({
      counts: [
        { category: "authz", status: "declined", net: 0, findings: 3, thumbsUp: 0, thumbsDown: 0 },
        { category: "style", status: "fixed", net: 0, findings: 3, thumbsUp: 0, thumbsDown: 0 },
      ],
    });
    const counts = await collectFeedback(deps);
    expect(counts.categoriesFlagged).toBe(1);
    expect(reports[0]?.key).toBe(FEEDBACK_REPORT_KEY);
    const report = feedbackReportSchema.parse(JSON.parse(reports[0]?.body ?? ""));
    expect(report.categories[0]).toMatchObject({
      category: "authz",
      flagged: true,
      protected: true,
    });
    expect(report).toMatchObject({ threshold: 0.5, minSamples: 2, windowDays: 90 });
    expect(logs).toContain("feedback: category below the acceptance threshold");
  });

  it("counts a failed read and still writes the report", async () => {
    const { deps, reports } = fakes({ comments: [comment("f1", 1)], failReactions: true });
    const counts = await collectFeedback(deps);
    expect(counts).toMatchObject({ feedbackCommentsRead: 0, errors: 1 });
    expect(reports).toHaveLength(1);
  });
});
