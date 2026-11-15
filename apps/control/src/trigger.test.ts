import { parseRepoConfig, type RepoConfig } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { reviewGate, trustedActor, waitingCheckRun } from "./trigger.js";

const settings = (review: Record<string, unknown> = {}): RepoConfig["review"] =>
  parseRepoConfig({ review }).review;
const gate = (check_run: "required" | "optional" | "off" = "required") =>
  parseRepoConfig({ gate: { check_run } }).gate;

const push = { kind: "pr_updated" as const, actor: "dev" };
const opened = { kind: "pr_opened" as const, actor: "dev" };
const labelled = (label = "lgtmoose:review", extra: Record<string, unknown> = {}) => ({
  kind: "pr_labeled" as const,
  actor: "dev",
  label,
  ...extra,
});
const withLabel = { labels: ["bug", "LGTMoose:Review"] };
const none = { labels: [] };

describe("reviewGate", () => {
  it("reviews every open and push by default, as before", () => {
    expect(reviewGate(settings(), opened, none, false)).toEqual({ review: true });
    expect(reviewGate(settings(), push, none, true)).toEqual({ review: true });
    // A job queued before NIC-1077 has no kind: reviewed as before.
    expect(reviewGate(settings(), {}, none, true)).toEqual({ review: true });
  });

  it("always runs a review someone asked for", () => {
    for (const trigger of ["auto", "label", "command"]) {
      for (const requested of ["review", "full_review"] as const) {
        expect(
          reviewGate(settings({ trigger, on_push: "manual" }), { ...push, requested }, none, true),
        ).toEqual({ review: true });
      }
    }
  });

  it("gates a run for replies or explain as a push: the judge didn't ask for a code review", () => {
    for (const requested of ["replies", "explain"] as const) {
      const asked = { kind: "pr_updated" as const, actor: "dev", requested };
      // As before when every push is reviewed.
      expect(reviewGate(settings(), asked, none, true)).toEqual({ review: true });
      // Waits whenever a push would.
      expect(reviewGate(settings({ on_push: "manual" }), asked, none, true)).toMatchObject({
        review: false,
        waiting: true,
      });
      expect(reviewGate(settings({ trigger: "command" }), asked, none, false)).toMatchObject({
        review: false,
        waiting: true,
      });
      expect(reviewGate(settings({ trigger: "label" }), asked, none, true)).toMatchObject({
        review: false,
        waiting: true,
      });
      expect(reviewGate(settings({ trigger: "label" }), asked, withLabel, true)).toEqual({
        review: true,
      });
    }
  });

  it("with trigger: label, reviews only while the PR carries the label (any case)", () => {
    const label = settings({ trigger: "label" });
    expect(reviewGate(label, opened, none, false)).toMatchObject({ review: false, waiting: true });
    expect(reviewGate(label, push, none, true)).toMatchObject({ review: false, waiting: true });
    expect(reviewGate(label, push, withLabel, true)).toEqual({ review: true });
    expect(reviewGate(label, labelled(), withLabel, false)).toEqual({ review: true });
  });

  it("ignores other labels, labels in other modes, and a label already gone", () => {
    const label = settings({ trigger: "label" });
    expect(reviewGate(label, labelled("bug"), withLabel, false)).toMatchObject({
      review: false,
      waiting: false,
    });
    expect(reviewGate(settings(), labelled(), withLabel, false)).toMatchObject({
      review: false,
      waiting: false,
    });
    // Removed again before the run read the PR.
    expect(reviewGate(label, labelled(), { labels: ["bug"] }, false)).toMatchObject({
      review: false,
      waiting: true,
    });
  });

  it("takes a label from a person or a trusted bot, never from another bot", () => {
    const label = settings({ trigger: "label", trusted_bots: ["Claude[bot]"] });
    expect(
      reviewGate(
        label,
        labelled("lgtmoose:review", { actor: "claude[bot]", botActor: true }),
        withLabel,
        false,
      ),
    ).toEqual({ review: true });
    expect(
      reviewGate(
        label,
        labelled("lgtmoose:review", { actor: "renovate[bot]", botActor: true }),
        withLabel,
        false,
      ),
    ).toMatchObject({ review: false, waiting: false });
  });

  it("with trigger: command, waits for every open and push", () => {
    const command = settings({ trigger: "command" });
    expect(reviewGate(command, opened, withLabel, false)).toMatchObject({
      review: false,
      waiting: true,
    });
    expect(reviewGate(command, labelled(), withLabel, false)).toMatchObject({
      review: false,
      waiting: false,
    });
  });

  it("with on_push: manual, reviews once, then only on a trigger", () => {
    const manual = settings({ on_push: "manual" });
    expect(reviewGate(manual, opened, none, false)).toEqual({ review: true });
    expect(reviewGate(manual, push, none, false)).toEqual({ review: true });
    expect(reviewGate(manual, push, none, true)).toMatchObject({ review: false, waiting: true });
    const label = settings({ trigger: "label", on_push: "manual" });
    expect(reviewGate(label, push, withLabel, true)).toMatchObject({ review: false });
    // Adding the label again is the trigger.
    expect(reviewGate(label, labelled(), withLabel, true)).toEqual({ review: true });
  });

  it("with label_once, takes the label off as the review starts", () => {
    const once = settings({ trigger: "label", label_once: true, label: "ready" });
    expect(reviewGate(once, labelled("ready"), { labels: ["ready"] }, false)).toEqual({
      review: true,
      removeLabel: "ready",
    });
    // Not in auto mode, where the label means nothing.
    expect(reviewGate(settings({ label_once: true }), push, withLabel, false)).toEqual({
      review: true,
    });
  });
});

describe("trustedActor", () => {
  it("trusts people, and only the listed bots", () => {
    const listed = settings({ trusted_bots: ["claude[bot]"] });
    expect(trustedActor(listed, "dev", undefined)).toBe(true);
    expect(trustedActor(listed, "CLAUDE[bot]", true)).toBe(true);
    expect(trustedActor(listed, "dependabot[bot]", true)).toBe(false);
    expect(trustedActor(listed, undefined, true)).toBe(false);
  });
});

describe("waitingCheckRun", () => {
  it("blocks a required check, so unreviewed code can't merge on it", () => {
    const check = waitingCheckRun(settings({ trigger: "label" }), gate(), "moose", false);
    expect(check).toMatchObject({ conclusion: "action_required", title: "Waiting for a trigger" });
    // Escaped like every config value in Markdown; it renders as lgtmoose:review.
    expect(check?.summary).toContain("Add the lgtmoose\\:review label");
    expect(check?.summary).toContain("`@moose review`");
  });

  it("is neutral for an optional check, and absent with the check off", () => {
    expect(
      waitingCheckRun(settings({ trigger: "command" }), gate("optional"), undefined, true),
    ).toMatchObject({ conclusion: "neutral" });
    expect(waitingCheckRun(settings(), gate("off"), "moose", true)).toBeUndefined();
  });

  it("says when commits since the last review wait", () => {
    expect(
      waitingCheckRun(settings({ on_push: "manual" }), gate(), "moose", true)?.summary,
    ).toContain("since the last review");
  });
});

describe("the repo config", () => {
  it("defaults to today's behaviour", () => {
    expect(settings()).toEqual({
      trigger: "auto",
      on_push: "auto",
      label: "lgtmoose:review",
      label_once: false,
      trusted_bots: [],
    });
  });

  it("refuses trusted bots that aren't bot logins", () => {
    expect(() => parseRepoConfig({ review: { trusted_bots: ["octocat"] } })).toThrow(/bot logins/);
    expect(() => parseRepoConfig({ review: { trigger: "sometimes" } })).toThrow();
  });
});
