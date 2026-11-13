import { parseRepoConfig, type RepoConfig } from "@lgtmoose/config";
import { isSeverity, type Severity } from "./severity.js";

/** The review event posted to GitHub. */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * The check-run conclusions the decision uses. `action_required` asks a person to look (the
 * review didn't finish or something tried to steer it); `skipped` is for a run whose commit is
 * no longer the PR's head.
 */
export type CheckConclusion = "success" | "failure" | "neutral" | "action_required" | "skipped";

/** What the decision came to. `skipped` means the head moved during the run. */
export type DecisionOutcome = "approve" | "request_changes" | "comment" | "skipped";

/** What keeps a review from approving, apart from open findings. */
export type HoldReason = "incomplete" | "prompt_injection" | "approve_disabled";

/**
 * A finding still open on the PR. Only the severity matters here; findings from other
 * reviewers (verified, from M5) can carry their own fields, such as a source, and are counted
 * the same way.
 */
export interface OpenFinding {
  severity: Severity;
}

/** The parts of `.lgtmoose.yaml` the decision reads. */
export type DecisionConfig = Pick<RepoConfig, "gate" | "labels">;

export interface DecisionContext {
  /** Every batch was reviewed. False when one failed or was left out, so nothing can approve. */
  complete: boolean;
  /** A prompt-injection attempt was flagged during the run. Never approve then. */
  injectionFlagged: boolean;
  /** The PR's head SHA moved while the run was going; its result is about an old commit. */
  headMoved: boolean;
}

export interface FindingCounts {
  blocking: number;
  should_fix: number;
  nit: number;
}

export interface ReviewDecision {
  outcome: DecisionOutcome;
  /** The review event to post. */
  event: ReviewEvent;
  /**
   * The one status label to set (the other two are removed). Undefined when the decision was
   * skipped: labels are left alone, since they describe the newer head.
   */
  label: string | undefined;
  /** The check-run conclusion. Undefined when `gate.check_run` is `off`: post no check run. */
  conclusion: CheckConclusion | undefined;
  /**
   * What kept the review from approving, or would have: an incomplete run, a flagged
   * prompt-injection attempt, `gate.approve: false`. Listed whatever the findings, for the
   * summary. Empty when the decision was skipped.
   */
  holds: HoldReason[];
  counts: FindingCounts;
}

/** The gate and labels of an empty `.lgtmoose.yaml`, for callers without a repo config. */
export const DEFAULT_DECISION_CONFIG: DecisionConfig = (() => {
  const { gate, labels } = parseRepoConfig({});
  return { gate, labels };
})();

/**
 * Counts open findings by severity. A severity it doesn't know (a bad row, a new source) throws
 * rather than being left out, which could let the review approve.
 */
export function countFindings(findings: readonly OpenFinding[]): FindingCounts {
  const counts: FindingCounts = { blocking: 0, should_fix: 0, nit: 0 };
  for (const finding of findings) {
    const severity: unknown = finding.severity;
    if (!isSeverity(severity)) throw new TypeError(`Unknown finding severity: ${String(severity)}`);
    counts[severity] += 1;
  }
  return counts;
}

/**
 * What the check reports under the gate setting: an optional gate never fails or holds a
 * merge, so anything short of success (or skipped) becomes neutral; `off` posts no check.
 */
function forGate(
  conclusion: CheckConclusion,
  checkRun: DecisionConfig["gate"]["check_run"],
): CheckConclusion | undefined {
  if (checkRun === "off") return undefined;
  if (checkRun === "optional" && conclusion !== "success" && conclusion !== "skipped") {
    return "neutral";
  }
  return conclusion;
}

/**
 * The review decision, a pure function of the findings still open on the PR (ours and verified
 * ones from other reviewers) and how the run went. The model never decides this.
 *
 * - Any open blocking finding: REQUEST_CHANGES, the changes label, a failing check.
 * - Otherwise any open should-fix finding: COMMENT, the changes label, a neutral check (a real
 *   problem, but not one that blocks the merge).
 * - Otherwise APPROVE, the approved label and a passing check. Nits never block.
 *
 * It never approves when the review is incomplete or a prompt-injection attempt was flagged.
 * Without blocking findings those post COMMENT with a check that asks a person to look
 * (`action_required`), and the pending label unless should-fix findings are open. With
 * `gate.approve: false` a clean review posts COMMENT instead of APPROVE but keeps the approved
 * label and a passing check. When the head moved during the run, the decision is skipped: the
 * post is a COMMENT, labels are left alone and the check is marked skipped.
 *
 * `gate.check_run: optional` turns failing and held checks into neutral ones; `off` posts no
 * check run. `gate.nit_cap` limits how many nits are posted; it doesn't affect the decision.
 */
export function decide(
  openFindings: readonly OpenFinding[],
  context: DecisionContext,
  config: DecisionConfig = DEFAULT_DECISION_CONFIG,
): ReviewDecision {
  const counts = countFindings(openFindings);
  const { gate, labels } = config;
  const result = (
    outcome: DecisionOutcome,
    event: ReviewEvent,
    label: string | undefined,
    conclusion: CheckConclusion,
    holds: HoldReason[],
  ): ReviewDecision => ({
    outcome,
    event,
    label,
    conclusion: forGate(conclusion, gate.check_run),
    holds,
    counts,
  });

  if (context.headMoved) return result("skipped", "COMMENT", undefined, "skipped", []);

  const holds: HoldReason[] = [];
  if (!context.complete) holds.push("incomplete");
  if (context.injectionFlagged) holds.push("prompt_injection");
  const held = holds.length > 0;
  if (!gate.approve) holds.push("approve_disabled");

  if (counts.blocking > 0) {
    return result("request_changes", "REQUEST_CHANGES", labels.changes, "failure", holds);
  }
  if (counts.should_fix > 0) {
    const conclusion = held ? "action_required" : "neutral";
    return result("comment", "COMMENT", labels.changes, conclusion, holds);
  }
  if (held) return result("comment", "COMMENT", labels.pending, "action_required", holds);
  const event = gate.approve ? "APPROVE" : "COMMENT";
  return result("approve", event, labels.approved, "success", holds);
}
