import { describe, expect, it } from "vitest";
import {
  acceptanceByCategory,
  currentReactions,
  feedbackReportSchema,
  type CategoryStatusCount,
} from "./feedback.js";

const row = (
  category: string,
  status: CategoryStatusCount["status"],
  findings: number,
  net: -1 | 0 | 1 = 0,
  thumbs: { up?: number; down?: number } = {},
): CategoryStatusCount => ({
  category,
  status,
  net,
  findings,
  thumbsUp: thumbs.up ?? 0,
  thumbsDown: thumbs.down ?? 0,
});

describe("acceptanceByCategory", () => {
  it("counts fixed and 👍 as accepted, declined, disputed and 👎 as rejected", () => {
    const [report] = acceptanceByCategory(
      [
        row("correctness", "fixed", 4),
        row("correctness", "open", 2, 1, { up: 2 }),
        row("correctness", "declined", 3),
        row("correctness", "disputed", 1),
        row("correctness", "outdated", 1, -1, { down: 1 }),
        // Neither: open with no reaction, a tie, resolved without a word.
        row("correctness", "open", 5),
        row("correctness", "resolved_by_human", 2),
      ],
      { minSamples: 1 },
    );
    expect(report).toMatchObject({
      category: "correctness",
      findings: 18,
      fixed: 4,
      declined: 3,
      disputed: 1,
      thumbsUp: 2,
      thumbsDown: 1,
      accepted: 6,
      rejected: 5,
      acceptance: 6 / 11,
      flagged: false,
    });
  });

  it("lets a fix outweigh 👎 and a decline outweigh 👍", () => {
    const [report] = acceptanceByCategory(
      [row("style", "fixed", 1, -1, { down: 3 }), row("style", "declined", 1, 1, { up: 2 })],
      { minSamples: 1 },
    );
    expect(report).toMatchObject({ accepted: 1, rejected: 1, acceptance: 0.5 });
  });

  it("gives no acceptance below the sample minimum, and so flags nothing", () => {
    const [report] = acceptanceByCategory([row("style", "declined", 3)], { minSamples: 10 });
    expect(report).toMatchObject({ acceptance: null, flagged: false });
  });

  it("flags a category below the threshold, lowest first", () => {
    const reports = acceptanceByCategory(
      [
        row("nit_style", "declined", 8),
        row("nit_style", "fixed", 2),
        row("correctness", "fixed", 9),
        row("correctness", "declined", 1),
      ],
      { threshold: 0.5, minSamples: 10 },
    );
    expect(reports.map((report) => [report.category, report.acceptance, report.flagged])).toEqual([
      ["nit_style", 0.2, true],
      ["correctness", 0.9, false],
    ]);
  });

  it("flags a protected category with a note, never as one to demote", () => {
    const [report] = acceptanceByCategory([row("authz", "declined", 9), row("authz", "fixed", 1)], {
      minSamples: 10,
    });
    expect(report).toMatchObject({ protected: true, flagged: true });
    expect(report?.note).toMatch(/never demoted/);
  });

  it("smooths a small sample towards the org's acceptance, so 3 answers can flag (NIC-1081)", () => {
    // The org accepts most findings: 18 of 20 outside `style`.
    const org = [row("correctness", "fixed", 18), row("correctness", "declined", 2)];
    // Three declines of style: raw 0, smoothed (0 + 4·c) / (3 + 4), c = (18+2)/(23+4).
    const [style] = acceptanceByCategory([...org, row("style", "declined", 3)], {
      threshold: 0.5,
      minSamples: 3,
    });
    const centre = (18 + 2) / (18 + 5 + 4);
    expect(style).toMatchObject({ category: "style", acceptance: 0 });
    expect(style?.smoothed).toBeCloseTo((4 * centre) / 7, 10);
    expect(style?.flagged).toBe(true);
    // One decline after two fixes doesn't flap: raw 2/3, smoothed well above the threshold.
    const steady = acceptanceByCategory(
      [...org, row("naming", "fixed", 2), row("naming", "declined", 1)],
      { threshold: 0.5, minSamples: 3 },
    ).find((report) => report.category === "naming");
    expect(steady?.flagged).toBe(false);
    // Below `minSamples`, nothing is judged.
    const [few] = acceptanceByCategory([row("style", "declined", 2)], { minSamples: 3 });
    expect(few).toMatchObject({ acceptance: null, smoothed: null, flagged: false });
  });

  it("produces a report the schema takes", () => {
    const categories = acceptanceByCategory([row("security", "fixed", 1)]);
    expect(
      feedbackReportSchema.safeParse({
        version: 1,
        generatedAt: new Date(0).toISOString(),
        windowDays: 90,
        threshold: 0.5,
        minSamples: 10,
        categories,
        declined: [],
      }).success,
    ).toBe(true);
  });
});

describe("currentReactions", () => {
  const reaction = (user: string, content: string, at: string, userIsBot = false) => ({
    user,
    content,
    createdAt: at,
    userIsBot,
  });

  it("counts each person once, by their latest 👍 or 👎", () => {
    const current = currentReactions([
      reaction("ada", "+1", "2026-01-01T00:00:00Z"),
      reaction("Ada", "-1", "2026-01-02T00:00:00Z"),
      reaction("bob", "+1", "2026-01-01T00:00:00Z"),
      reaction("cy", "heart", "2026-01-01T00:00:00Z"),
    ]);
    expect([...current]).toEqual([
      ["ada", "-1"],
      ["bob", "+1"],
    ]);
  });

  it("leaves out bots and excluded logins", () => {
    const current = currentReactions(
      [
        reaction("renovate[bot]", "+1", "2026-01-01T00:00:00Z", true),
        reaction("lgtmoose", "+1", "2026-01-01T00:00:00Z"),
        reaction("dee", "-1", "2026-01-01T00:00:00Z"),
      ],
      (login) => login === "lgtmoose",
    );
    expect([...current]).toEqual([["dee", "-1"]]);
  });
});
