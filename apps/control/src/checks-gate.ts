import type { RepoConfig } from "@lgtmoose/config";
import type { CheckConclusion } from "@lgtmoose/core";
import type { HeadChecks } from "@lgtmoose/pipeline";
import { inline } from "@lgtmoose/summary";

/**
 * Wait for CI (NIC-1078): with `review.wait_for_checks`, a review starts only once the head's
 * checks pass. Decided in the prepare step, after the review trigger (NIC-1077) says the review
 * may start and before anything is cloned, so a run that waits reads no code and spends no model
 * time.
 *
 * - The checks are the names listed, or with `required` the base branch's required status
 *   checks. Each may be a check run or a commit status. LGTMoose's own check is never one.
 * - All passed (success, neutral or skipped): the review starts.
 * - One failed: the review waits until it passes, however long that takes. A failed check is
 *   what's about to change.
 * - Some still running, or not started: the review waits, for at most
 *   `review.wait_timeout_minutes` since the wait began. Then it starts anyway and its summary
 *   says it didn't wait.
 * - A person's `@lgtmoose review` (or `full review`) from someone with write access starts it
 *   now. The PR's author without write access, or a trusted bot, waits like a push.
 *
 * While a PR waits, the dispatcher keeps which head it waits on. A check finishing on that head
 * asks for a run again; a check on any other PR costs nothing.
 */

export type ReviewSettings = RepoConfig["review"];

/** LGTMoose's own check run (`CHECK_NAME` in @lgtmoose/poster): never waited for. */
const OWN_CHECK = "lgtmoose";

const PASSED_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);
const PASSED_STATUSES: ReadonlySet<string> = new Set(["success"]);
const FAILED_STATUSES: ReadonlySet<string> = new Set(["failure", "error"]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The checks to wait for, by name: the listed ones, or the required ones (`required`). Undefined
 * when there's nothing to wait for: `off`, or `required` on a branch that requires none.
 */
export function checksToWaitFor(
  setting: ReviewSettings["wait_for_checks"],
  required: readonly string[] | undefined,
): string[] | undefined {
  if (setting === "off") return undefined;
  const names = setting === "required" ? [...(required ?? [])] : [...setting];
  const wanted = [...new Set(names.map((name) => name.trim()))].filter(
    (name) => name !== "" && !same(name, OWN_CHECK),
  );
  return wanted.length === 0 ? undefined : wanted;
}

/** Where the checks a PR waits for stand. */
export interface ChecksState {
  state: "passed" | "failed" | "pending";
  failed: string[];
  pending: string[];
}

/**
 * Where each wanted check stands: passed, failed, or pending (running, or not reported yet). A
 * check run and a commit status of one name both count, and a failed one wins.
 */
export function checksState(wanted: readonly string[], head: HeadChecks): ChecksState {
  const failed: string[] = [];
  const pending: string[] = [];
  for (const name of wanted) {
    const outcomes: ("passed" | "failed" | "pending")[] = [];
    for (const run of head.runs) {
      if (!same(run.name, name)) continue;
      if (run.status !== "completed") outcomes.push("pending");
      else outcomes.push(PASSED_CONCLUSIONS.has(run.conclusion ?? "") ? "passed" : "failed");
    }
    for (const status of head.statuses) {
      if (!same(status.context, name)) continue;
      if (PASSED_STATUSES.has(status.state)) outcomes.push("passed");
      else if (FAILED_STATUSES.has(status.state)) outcomes.push("failed");
      else outcomes.push("pending");
    }
    if (outcomes.includes("failed")) failed.push(name);
    else if (outcomes.length === 0 || outcomes.includes("pending")) pending.push(name);
  }
  let state: ChecksState["state"] = "passed";
  if (failed.length > 0) state = "failed";
  else if (pending.length > 0) state = "pending";
  return {
    state,
    failed,
    pending,
  };
}

/** What the gate decided. */
export type ChecksDecision =
  | { review: true; timedOut?: { minutes: number; pending: string[] } }
  | { review: false; checks: ChecksState };

/**
 * Whether the review starts now. `since` is when this head's wait began (now, on the first
 * run that waits).
 */
export function checksGate(input: {
  settings: Pick<ReviewSettings, "wait_timeout_minutes">;
  checks: ChecksState;
  since: Date;
  now: Date;
}): ChecksDecision {
  const { checks, since, now, settings } = input;
  if (checks.state === "passed") return { review: true };
  if (checks.state === "failed") return { review: false, checks };
  const waited = now.getTime() - since.getTime();
  if (waited >= settings.wait_timeout_minutes * 60_000) {
    return {
      review: true,
      timedOut: { minutes: settings.wait_timeout_minutes, pending: checks.pending },
    };
  }
  return { review: false, checks };
}

/**
 * What the waiting check run last said, as the dispatcher keeps it: a run whose checks say the
 * same posts nothing new. Our own check run finishing is a check event too, so without this a
 * failed check would be posted about again and again.
 */
export function waitState(checks: ChecksState): string {
  return checks.state === "failed" ? `failed:${[...checks.failed].sort().join(",")}` : "pending";
}

const MAX_NAMED = 10;

/** Check names for a summary line: escaped, at most `MAX_NAMED`, the rest counted. */
function named(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMED).map((name) => inline(name));
  const more = names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : "";
  return `${shown.join(", ")}${more}`;
}

/** The check run a PR waiting for its CI gets: which checks, and how to start the review now. */
export function waitingForChecksRun(
  settings: Pick<ReviewSettings, "wait_timeout_minutes">,
  gate: RepoConfig["gate"],
  slug: string | undefined,
  checks: ChecksState,
): { conclusion: CheckConclusion; title: string; summary: string } | undefined {
  if (gate.check_run === "off") return undefined;
  // The handle that works here (NIC-1119); without one, name the command, not a guessed handle.
  const command = slug === undefined ? "the App's `review` command" : `\`@${slug} review\``;
  const now = `Someone with write access can start it now with ${command}.`;
  const summary =
    checks.state === "failed"
      ? `The review waits for these checks to pass: ${named(checks.failed)} failed. It starts once they pass. ${now}`
      : `The review starts when these checks pass: ${named(checks.pending)}. If they haven't finished within ${settings.wait_timeout_minutes} minutes, it starts anyway. ${now}`;
  return {
    // As a review trigger's wait: a required check mustn't pass on code nobody reviewed.
    conclusion: gate.check_run === "required" ? "action_required" : "neutral",
    title: checks.state === "failed" ? "Waiting for CI to pass" : "Waiting for CI",
    summary,
  };
}

/** The summary's note for a review that started without waiting for every check. */
export function timedOutNotice(timedOut: { minutes: number; pending: string[] }): string {
  const names = timedOut.pending.slice(0, MAX_NAMED).join(", ");
  const more =
    timedOut.pending.length > MAX_NAMED ? ` and ${timedOut.pending.length - MAX_NAMED} more` : "";
  return `This review didn't wait for CI: after ${timedOut.minutes} minutes, ${names}${more} still hadn't finished.`;
}
