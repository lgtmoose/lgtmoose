import { z } from "zod";
import { isProtectedCategory } from "./fingerprint.js";
import { SEVERITIES } from "./severity.js";

/**
 * Feedback signals (NIC-841): how often people accept LGTMoose's findings, per rule category.
 * Signals only: nothing here changes a decision, a severity or a rule. A category whose
 * acceptance falls below the threshold is flagged for a person to look at.
 *
 * A finding counts as
 * - accepted when it was fixed, or nobody declined or disputed it and it has more 👍 than 👎;
 * - rejected when it was declined or disputed (and upheld as wrong), or it wasn't fixed and has
 *   more 👎 than 👍;
 * - neither otherwise (still open, outdated, resolved without a word, or as many 👍 as 👎).
 *
 * Acceptance is accepted / (accepted + rejected), once a category has `minSamples` of those.
 *
 * Whether a category is flagged goes by its smoothed acceptance (NIC-1081), so a new install
 * can flag after a few answers without flapping on one: a Beta prior worth `PRIOR_WEIGHT`
 * answers, centred on the org's overall acceptance (itself under a Beta(2,2) prior, so it's 0.5
 * with no answers at all), mixed with the category's own counts.
 */

/** A finding status, as `findings.status` stores it. */
export const FEEDBACK_STATUSES = [
  "open",
  "fixed",
  "declined",
  "disputed",
  "resolved_by_human",
  "outdated",
  // Retired from shadow mode unanswered (NIC-1141): neither accepted nor rejected.
  "shadow",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Findings of one category and status with the same reaction balance. */
export interface CategoryStatusCount {
  category: string;
  status: FeedbackStatus;
  /** The sign of 👍 minus 👎 on the finding's inline comment: 1, 0 or -1. */
  net: -1 | 0 | 1;
  /** How many findings. */
  findings: number;
  /** 👍 and 👎 on those findings' comments, one per person each. */
  thumbsUp: number;
  thumbsDown: number;
}

export const DEFAULT_ACCEPTANCE_THRESHOLD = 0.5;
export const DEFAULT_MIN_SAMPLES = 3;
/** How many answers the prior counts as, against a category's own (NIC-1081). */
export const PRIOR_WEIGHT = 4;
/** How far back the report looks, by when a finding was raised. */
export const FEEDBACK_WINDOW_DAYS = 90;
/** The most declined findings the report lists for `lgtmoose evals export-declined`. */
export const MAX_DECLINED_LISTED = 200;

const categoryReportSchema = z
  .object({
    category: z.string(),
    /** A protected category (authz, tenant_scoping, money, secrets…): never demoted automatically. */
    protected: z.boolean(),
    findings: z.number().int().min(0),
    fixed: z.number().int().min(0),
    declined: z.number().int().min(0),
    disputed: z.number().int().min(0),
    thumbsUp: z.number().int().min(0),
    thumbsDown: z.number().int().min(0),
    accepted: z.number().int().min(0),
    rejected: z.number().int().min(0),
    /** accepted / (accepted + rejected); null below `minSamples`. */
    acceptance: z.number().min(0).max(1).nullable(),
    /**
     * Acceptance mixed with the prior (see above): what `flagged` goes by. Null below
     * `minSamples`; left out by reports from before NIC-1081.
     */
    smoothed: z.number().min(0).max(1).nullable().optional(),
    /** Smoothed acceptance below the threshold, with enough samples: for a person to look at. */
    flagged: z.boolean(),
    note: z.string().optional(),
  })
  .strict();

export type CategoryReport = z.infer<typeof categoryReportSchema>;

/** A declined finding, enough to rebuild a "must not flag" eval fixture from the repository. */
export const declinedFindingSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    prNumber: z.number().int().positive(),
    path: z.string().min(1),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    side: z.enum(["LEFT", "RIGHT"]),
    category: z.string(),
    severity: z.enum(SEVERITIES),
    title: z.string(),
    /** The commit the finding was raised at: the file as the reviewer read it. */
    raisedAtSha: z.string().regex(/^[0-9a-f]{40}$/),
    /** The PR's base when last recorded. */
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export type DeclinedFinding = z.infer<typeof declinedFindingSchema>;

/** The report the reconciler writes, the CLI prints and the dashboard (NIC-840) will read. */
export const feedbackReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string(),
    windowDays: z.number().int().positive(),
    threshold: z.number().min(0).max(1),
    minSamples: z.number().int().min(1),
    categories: z.array(categoryReportSchema),
    declined: z.array(declinedFindingSchema).max(MAX_DECLINED_LISTED),
  })
  .strict();

export type FeedbackReport = z.infer<typeof feedbackReportSchema>;

function isAccepted(status: FeedbackStatus, net: number): boolean {
  if (status === "fixed") return true;
  return status !== "declined" && status !== "disputed" && net > 0;
}

function isRejected(status: FeedbackStatus, net: number): boolean {
  if (status === "declined" || status === "disputed") return true;
  return status !== "fixed" && net < 0;
}

/** Acceptance per category, from counts by category, status and reaction balance. */
export function acceptanceByCategory(
  counts: readonly CategoryStatusCount[],
  options: { threshold?: number; minSamples?: number } = {},
): CategoryReport[] {
  const threshold = options.threshold ?? DEFAULT_ACCEPTANCE_THRESHOLD;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const byCategory = new Map<string, CategoryStatusCount[]>();
  for (const count of counts) {
    const list = byCategory.get(count.category) ?? [];
    list.push(count);
    byCategory.set(count.category, list);
  }
  // The prior's centre: the org's acceptance over every category, under Beta(2,2).
  const allAccepted = counts.reduce(
    (total, row) => total + (isAccepted(row.status, row.net) ? row.findings : 0),
    0,
  );
  const allRejected = counts.reduce(
    (total, row) => total + (isRejected(row.status, row.net) ? row.findings : 0),
    0,
  );
  const centre = (allAccepted + 2) / (allAccepted + allRejected + 4);
  const reports = [...byCategory].map(([category, rows]): CategoryReport => {
    const sum = (pick: (row: CategoryStatusCount) => number) =>
      rows.reduce((total, row) => total + pick(row), 0);
    const ofStatus = (status: FeedbackStatus) =>
      sum((row) => (row.status === status ? row.findings : 0));
    const accepted = sum((row) => (isAccepted(row.status, row.net) ? row.findings : 0));
    const rejected = sum((row) => (isRejected(row.status, row.net) ? row.findings : 0));
    const samples = accepted + rejected;
    const acceptance = samples >= minSamples ? accepted / samples : null;
    const smoothed =
      samples >= minSamples ? (accepted + PRIOR_WEIGHT * centre) / (samples + PRIOR_WEIGHT) : null;
    const low = smoothed !== null && smoothed < threshold;
    const protectedCategory = isProtectedCategory(category);
    return {
      category,
      protected: protectedCategory,
      findings: sum((row) => row.findings),
      fixed: ofStatus("fixed"),
      declined: ofStatus("declined"),
      disputed: ofStatus("disputed"),
      thumbsUp: sum((row) => row.thumbsUp),
      thumbsDown: sum((row) => row.thumbsDown),
      accepted,
      rejected,
      acceptance,
      smoothed,
      flagged: low,
      ...(low && protectedCategory
        ? {
            note: "A protected category: it's never demoted. Look at its rules and findings instead.",
          }
        : {}),
    };
  });
  // Lowest acceptance first, then the most findings: what to look at first is on top.
  return reports.sort(
    (a, b) =>
      (a.acceptance ?? 2) - (b.acceptance ?? 2) ||
      b.findings - a.findings ||
      a.category.localeCompare(b.category),
  );
}

/**
 * The reactions to count on one comment: each person once, their latest 👍 or 👎. Bots and
 * `exclude` (our own App) don't count.
 */
export function currentReactions(
  reactions: readonly {
    content: string;
    user: string;
    userIsBot: boolean;
    createdAt: string;
  }[],
  exclude: (login: string) => boolean = () => false,
): Map<string, "+1" | "-1"> {
  const latest = new Map<string, { reaction: "+1" | "-1"; at: number }>();
  for (const reaction of reactions) {
    if (reaction.content !== "+1" && reaction.content !== "-1") continue;
    if (reaction.userIsBot || exclude(reaction.user)) continue;
    const user = reaction.user.toLowerCase();
    const at = Date.parse(reaction.createdAt);
    const seen = latest.get(user);
    if (seen === undefined || !(seen.at > at)) latest.set(user, { reaction: reaction.content, at });
  }
  return new Map([...latest].map(([user, { reaction }]) => [user, reaction]));
}
