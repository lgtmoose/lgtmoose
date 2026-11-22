import type { RepoConfig } from "@lgtmoose/config";
import type { CheckConclusion } from "@lgtmoose/core";
import { inline } from "@lgtmoose/summary";
import type { WorkflowJob } from "./job.js";

/**
 * Review triggers (NIC-1077): whether a run reviews the PR, from the repo's `review` config at
 * the base commit (a PR can't change its own trigger) and the PR's labels as GitHub has them now.
 * Decided in the prepare step before the clone, so a run that doesn't review spends no model time
 * and reads no code.
 *
 * - A person's `review` or `full review` always runs: someone asked. (The conversation handler
 *   already checked who may ask.) A run for replies or `explain` is gated like a push; when that
 *   waits, it judges and explains without reviewing the code.
 * - A label added (`pr_labeled`) starts a review only when it's `review.label`, the trigger is
 *   `label`, and a person added it or a bot in `review.trusted_bots` did. Anything else is
 *   ignored: nothing is posted.
 * - An open, ready or push run follows `review.trigger`: `auto` reviews, `label` reviews while
 *   the PR carries the label, `command` never does. After the PR's first review,
 *   `review.on_push: manual` waits for the label (added again) or a command.
 * - A run that waits says so in the check run, so people know how to start a review.
 */

export type ReviewSettings = RepoConfig["review"];

export type GateDecision =
  { review: true; removeLabel?: string } | { review: false; reason: string; waiting: boolean };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether `actor` may start a review here: a person, or one of the repo's trusted bots. */
export function trustedActor(
  settings: Pick<ReviewSettings, "trusted_bots">,
  actor: string | undefined,
  botActor: boolean | undefined,
): boolean {
  if (botActor !== true) return true;
  return actor !== undefined && settings.trusted_bots.some((bot) => same(bot, actor));
}

export function reviewGate(
  settings: ReviewSettings,
  job: Pick<WorkflowJob, "kind" | "requested" | "label" | "actor" | "botActor">,
  pr: { labels: readonly string[] },
  reviewedBefore: boolean,
  /** Succeeded automatic reviews since the last `resume` or requested review. */
  automaticReviews = 0,
): GateDecision {
  if (job.requested === "review" || job.requested === "full_review") return { review: true };
  // A run for replies or an `explain` isn't anyone asking for a code review: the reply judge and
  // the explainer queue it. It's gated as a push would be; when that waits, the run only judges
  // and explains (`conversationOnly` in the prepare step).
  if (job.requested !== undefined) {
    const push = {
      kind: "pr_updated" as const,
      ...(job.actor === undefined ? {} : { actor: job.actor }),
      ...(job.botActor === undefined ? {} : { botActor: job.botActor }),
    };
    return reviewGate(settings, push, pr, reviewedBefore, automaticReviews);
  }
  const labelled = pr.labels.some((name) => same(name, settings.label));
  const removeLabel =
    settings.label_once && settings.trigger === "label" ? settings.label : undefined;
  const pass = (): GateDecision =>
    removeLabel === undefined ? { review: true } : { review: true, removeLabel };

  // A check finished on a head whose review waits for CI (NIC-1078): the dispatcher starts this
  // only for the head the PR waits on, and a PR waits only once its trigger said the review may
  // start. Only a review label can have come off since.
  if (job.kind === "pr_checks") {
    if (settings.trigger === "label" && !labelled) {
      return { review: false, reason: "the label is gone", waiting: true };
    }
    return pass();
  }

  if (job.kind === "pr_labeled") {
    if (settings.trigger !== "label") {
      return { review: false, reason: "labels don't start reviews here", waiting: false };
    }
    if (job.label === undefined || !same(job.label, settings.label)) {
      return { review: false, reason: "not the review label", waiting: false };
    }
    if (!trustedActor(settings, job.actor, job.botActor)) {
      return { review: false, reason: "added by a bot that isn't trusted", waiting: false };
    }
    // Read again now: the label may have come off since the event.
    if (!labelled) return { review: false, reason: "the label is gone", waiting: true };
    return pass();
  }

  // A trusted bot's push or open counts like anyone's; an untrusted bot's never got here.
  const push = job.kind === "pr_updated";
  const pausedAfter =
    push &&
    settings.auto_pause_after !== undefined &&
    automaticReviews >= settings.auto_pause_after;
  if (pausedAfter) {
    return {
      review: false,
      reason: `paused after ${settings.auto_pause_after} reviews`,
      waiting: true,
    };
  }
  const manualAgain = settings.on_push === "manual" && reviewedBefore && push;
  switch (settings.trigger) {
    case "auto":
      return manualAgain
        ? { review: false, reason: "new commits wait for a trigger", waiting: true }
        : { review: true };
    case "label":
      if (!labelled)
        return { review: false, reason: "waiting for the review label", waiting: true };
      return manualAgain
        ? { review: false, reason: "new commits wait for a trigger", waiting: true }
        : pass();
    case "command":
      return { review: false, reason: "waiting for a review command", waiting: true };
  }
}

/** The check run a waiting PR gets: how to start its review. */
export function waitingCheckRun(
  settings: ReviewSettings,
  gate: RepoConfig["gate"],
  slug: string | undefined,
  reviewedBefore: boolean,
  /** Succeeded automatic reviews since the last reset, for the pause message. */
  automaticReviews = 0,
): { conclusion: CheckConclusion; title: string; summary: string } | undefined {
  if (gate.check_run === "off") return undefined;
  // The handle that works here (NIC-1119); without one, name the command, not a guessed handle.
  const command = slug === undefined ? "the App's `review` command" : `\`@${slug} review\``;
  const ways =
    settings.trigger === "label"
      ? `Add the ${inline(settings.label)} label, or comment ${command}.`
      : `Comment ${command}.`;
  const what = reviewedBefore
    ? "The commits since the last review haven't been reviewed."
    : "This pull request hasn't been reviewed yet.";
  const paused =
    settings.auto_pause_after !== undefined && automaticReviews >= settings.auto_pause_after
      ? ` Automatic reviews are paused after ${automaticReviews}. Comment ${command}, or \`resume\`, to continue.`
      : "";
  return {
    // A required check mustn't pass on code nobody reviewed: action_required keeps the PR from
    // merging until it is. An optional one is neutral.
    conclusion: gate.check_run === "required" ? "action_required" : "neutral",
    title: "Waiting for a trigger",
    summary: `${what} This repository reviews pull requests when asked. ${ways}${paused}`,
  };
}
