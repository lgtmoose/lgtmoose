import { SEVERITIES, severityRank, type Finding, type Severity } from "@lgtmoose/core";
import type { FileDiff } from "@lgtmoose/git";
import type { Plan, ReadingDepth, SkipReason, SkippedFile } from "@lgtmoose/planner";
import { clip, inline, link, paragraphs } from "./markdown.js";

/** GitHub refuses issue and PR comments longer than this. */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** Longest hidden marker the poster puts in a body (`reviewMarkerComment` in @lgtmoose/poster). */
export const MAX_MARKER_LENGTH = 100;

/**
 * Room to leave under the limit for the hidden marker the poster appends to the comment
 * (`upsertSummaryComment` in @lgtmoose/poster), so the comment never has to be cut to fit it:
 * the longest marker, in its comment, after a blank line.
 */
export const SUMMARY_MARKER_ROOM = `\n\n<!--  -->`.length + MAX_MARKER_LENGTH;

/** The review event the decision maps to. */
export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export interface SummaryDecision {
  event: ReviewEvent;
  /**
   * The status label the PR should carry, from `labels` in .lgtmoose.yaml. Leave out when the
   * decision was skipped because the head moved during the run: labels are left alone then.
   */
  label?: string;
  /**
   * Why the decision is weaker than the findings alone would give, such as "the review didn't
   * finish" or "the head moved during the run". Shown as written: plain code text, not PR text.
   */
  reasons?: readonly string[];
}

/**
 * How much of a ticket the PR covers: `unclear` when the checker couldn't judge its core
 * requirements, `not_checked` when the check failed or didn't run.
 */
export type TicketCoverageLevel = "covered" | "partial" | "not_covered" | "unclear" | "not_checked";

export interface TicketCoverage {
  /** The ticket provider's name, such as Linear. */
  provider: string;
  tickets: readonly {
    key: string;
    title: string;
    url?: string;
    coverage: TicketCoverageLevel;
    /** From the ticket checker (model output) or plain code; rendered as plain text. */
    note?: string;
    /** Core requirements the checker found missing (model output; rendered as plain text). */
    missing?: readonly string[];
  }[];
  /** A line under the table, such as how missing requirements count. Plain code text. */
  footnote?: string;
}

export interface SummaryInput {
  /** The commit the review is for. */
  headSha: string;
  /** Every file the PR changes, as the diff gives them. */
  files: readonly FileDiff[];
  /** The planner's result: which files were reviewed, how closely, and which were skipped. */
  plan: Pick<Plan, "files" | "skipped">;
  decision: SummaryDecision;
  /** The PR's open findings: what still needs attention, whoever raised it. */
  findings: readonly Finding[];
  /** A short description of the change, from the model. Untrusted; rendered as plain text. */
  walkthrough?: string;
  /** Only when a ticket provider is configured. */
  tickets?: TicketCoverage;
  /** Convention files that matched but were left out of the prompt to stay within limits. */
  conventionFilesOmitted?: readonly string[];
  /**
   * Rule-pack entries or rules from `.lgtmoose.yaml` that were left out, and why, so the repo's
   * owners can fix their config. May quote repository text; rendered as plain text.
   */
  rulePackProblems?: readonly string[];
  /** Findings past the per-run limit that were dropped, least severe first. */
  findingsOverLimit?: number;
  /** Status labels the repo doesn't have (from `syncStatusLabel`), so they couldn't be set. */
  missingLabels?: readonly string[];
  /** Model usage per provider for this run (`summarizeUsage` in @lgtmoose/harness). */
  usage?: readonly ProviderUsage[];
  /**
   * Files the PR changed at an earlier review and no longer changes at all, with the lines it
   * added then and no longer does (from the PR, so untrusted; escaped as text).
   */
  noLongerChanged?: readonly { path: string; lines: readonly string[] }[];
}

/** One provider's usage over a run, for the footer. */
export interface ProviderUsage {
  providerId: string;
  /** Runs that produced output. */
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Rate limits, used-up plans and rejected credentials. */
  limitHits: number;
  /** Times a run moved past this provider to the next one. */
  fallbacks: number;
}

export interface RenderOptions {
  /** Longest comment allowed. Defaults to GitHub's limit. */
  maxLength?: number;
}

/** More files than this and the changes table is grouped by folder. */
export const GROUP_FILES_OVER = 10;

// Every list and text in the status section is capped, so its least detailed form always fits
// well under GitHub's limit however large the PR is.
const LIST_LIMIT = 25;
const LOCKFILE_LIMIT = 10;
const NOTES_PER_LOCKFILE = 5;
const NO_LONGER_CHANGED_LIMIT = 10;
const LINES_PER_NO_LONGER_CHANGED = 5;
const REASON_LIMIT = 10;
/** Longest single item (a path, a note, a reason) shown in a list. */
const ITEM_LENGTH = 200;
const WALKTHROUGH_LIMIT = 8_000;

const EVENT_TEXT: Record<ReviewEvent, string> = {
  APPROVE: "Approved",
  COMMENT: "Commented, no approval",
  REQUEST_CHANGES: "Changes requested",
};

const SEVERITY_TEXT: Record<Severity, string> = {
  blocking: "Blocking",
  should_fix: "Should fix",
  nit: "Nit",
};

const DEPTH_TEXT: Record<ReadingDepth, string> = {
  full: "full review",
  mechanical: "imports only",
  move: "moved only",
};

const SKIP_TEXT: Record<SkipReason, string> = {
  binary: "binary",
  lockfile: "lockfile",
  minified: "minified",
  generated: "generated",
  "build-output": "build output",
  vendored: "vendored",
  config: "skipped by .lgtmoose.yaml",
};

const COVERAGE_TEXT: Record<TicketCoverageLevel, string> = {
  covered: "Covered",
  partial: "Partly covered",
  not_covered: "Not covered",
  unclear: "Unclear",
  not_checked: "Not checked",
};

/** Missing requirements listed per ticket. */
const MISSING_PER_TICKET = 5;

/** How much detail to render; lower levels are tried when the comment is too long. */
interface Detail {
  walkthrough: boolean;
  fileRows: boolean;
  fileTable: boolean;
  findingRows: number;
}

const DETAIL_LEVELS: readonly Detail[] = [
  { walkthrough: true, fileRows: true, fileTable: true, findingRows: Number.POSITIVE_INFINITY },
  { walkthrough: true, fileRows: false, fileTable: true, findingRows: 100 },
  { walkthrough: false, fileRows: false, fileTable: true, findingRows: 25 },
  { walkthrough: false, fileRows: false, fileTable: false, findingRows: 0 },
];

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** At most `limit` items as list lines, with a line saying how many more there are. */
function bullets(items: readonly string[], limit = LIST_LIMIT): string[] {
  const shown = items.slice(0, limit).map((item) => `  - ${inline(clip(item, ITEM_LENGTH))}`);
  if (items.length > limit) shown.push(`  - …and ${items.length - limit} more`);
  return shown;
}

function shortSha(sha: string): string {
  return /^[0-9a-f]{7,64}$/i.test(sha) ? `\`${sha.slice(0, 12)}\`` : inline(sha);
}

function lineCounts(file: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "del") removed += 1;
    }
  }
  return { added, removed };
}

function pathText(file: FileDiff): string {
  return file.oldPath === undefined || file.oldPath === file.path
    ? inline(file.path)
    : `${inline(file.oldPath)} → ${inline(file.path)}`;
}

/** Which folder a file is listed under when the table is grouped. */
function groupOf(path: string): string {
  const parts = path.split("/");
  if (parts.length === 1) return "(repository root)";
  // In a monorepo, packages/x and apps/y say more than packages alone.
  return parts.length > 2 ? `${parts[0]}/${parts[1]}/` : `${parts[0]}/`;
}

function byPath(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function renderStatus(input: SummaryInput): string {
  const lines = ["### Review status", ""];
  lines.push(`- **Commit:** ${shortSha(input.headSha)}`);
  // The outcome first: if anything below is ever cut, these lines survive.
  lines.push(`- **Decision:** ${EVENT_TEXT[input.decision.event]}`);
  lines.push(...bullets(input.decision.reasons ?? [], REASON_LIMIT));
  const label = input.decision.label;
  lines.push(
    label === undefined
      ? "- **Label:** unchanged (the review is for an older commit)"
      : `- **Label:** ${inline(clip(label, ITEM_LENGTH))}`,
  );
  const missing = input.missingLabels ?? [];
  if (missing.length > 0) {
    lines.push(
      `  - The repository has no ${missing.map((label) => inline(clip(label, ITEM_LENGTH))).join(", ")} ${missing.length === 1 ? "label" : "labels"}. LGTMoose doesn't create labels; add them in the repository's settings.`,
    );
  }

  const severities = SEVERITIES.map((severity) => {
    const n = input.findings.filter((finding) => finding.severity === severity).length;
    return `${n} ${SEVERITY_TEXT[severity].toLowerCase()}`;
  });
  lines.push(`- **Open findings:** ${input.findings.length} (${severities.join(", ")})`);
  const over = input.findingsOverLimit ?? 0;
  if (over > 0) {
    lines.push(
      `  - ${count(over, "more finding")} past the per-batch limit, least severe first, weren't posted`,
    );
  }

  const depths = new Map<ReadingDepth, number>();
  for (const planned of input.plan.files) {
    depths.set(planned.depth, (depths.get(planned.depth) ?? 0) + 1);
  }
  const reviewed = (["full", "mechanical", "move"] as const)
    .filter((depth) => (depths.get(depth) ?? 0) > 0)
    .map((depth) => `${depths.get(depth) ?? 0} ${DEPTH_TEXT[depth]}`);
  lines.push(
    `- **Files reviewed:** ${input.plan.files.length}${reviewed.length > 0 ? ` (${reviewed.join(", ")})` : ""}`,
  );

  const skipped = input.plan.skipped;
  const reasons = new Map<SkipReason, number>();
  for (const entry of skipped) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  const byType = [...reasons]
    .sort(([a], [b]) => byPath(a, b))
    .map(([reason, n]) => `${n} ${SKIP_TEXT[reason]}`);
  lines.push(
    `- **Files skipped:** ${skipped.length}${byType.length > 0 ? ` (${byType.join(", ")})` : ""}`,
  );

  const newCode = skipped.filter((entry) => entry.newCode === true);
  if (newCode.length > 0) {
    lines.push(
      `- **New code, not reviewed:** ${count(newCode.length, "file")} added to vendored, build or generated paths`,
      ...bullets(newCode.map((entry) => entry.file.path)),
    );
  }

  const noted = skipped.filter(
    (entry): entry is SkippedFile & { notes: string[] } => (entry.notes?.length ?? 0) > 0,
  );
  if (noted.length > 0) {
    lines.push("- **Dependency changes to check:**");
    for (const entry of noted.slice(0, LOCKFILE_LIMIT)) {
      lines.push(`  - ${inline(clip(entry.file.path, ITEM_LENGTH))}`);
      lines.push(...bullets(entry.notes, NOTES_PER_LOCKFILE).map((l) => `  ${l}`));
    }
    if (noted.length > LOCKFILE_LIMIT) {
      lines.push(`  - …and ${noted.length - LOCKFILE_LIMIT} more files`);
    }
  }

  const dropped = input.noLongerChanged ?? [];
  if (dropped.length > 0) {
    lines.push("- **No longer changed by the PR** (it added these lines at an earlier review):");
    for (const entry of dropped.slice(0, NO_LONGER_CHANGED_LIMIT)) {
      lines.push(`  - ${inline(clip(entry.path, ITEM_LENGTH))}`);
      lines.push(...bullets(entry.lines, LINES_PER_NO_LONGER_CHANGED).map((l) => `  ${l}`));
    }
    if (dropped.length > NO_LONGER_CHANGED_LIMIT) {
      lines.push(`  - …and ${dropped.length - NO_LONGER_CHANGED_LIMIT} more files`);
    }
  }

  const omitted = input.conventionFilesOmitted ?? [];
  if (omitted.length > 0) {
    lines.push(
      `- **Convention files left out** (over the size limit): ${count(omitted.length, "file")}`,
      ...bullets(omitted),
    );
  }

  const packProblems = input.rulePackProblems ?? [];
  if (packProblems.length > 0) {
    lines.push(
      `- **Rule pack problems** (check \`rulepacks\` in \`.lgtmoose.yaml\` and the files in \`rules/\`): ${count(packProblems.length, "problem")}`,
      ...bullets(packProblems),
    );
  }

  return lines.join("\n");
}

function renderFindings(findings: readonly Finding[], rows: number): string | undefined {
  if (findings.length === 0 || rows === 0) return undefined;
  const sorted = [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      byPath(a.path, b.path) ||
      a.line - b.line,
  );
  const lines = ["### Open findings", "", "| Severity | Where | Finding |", "| --- | --- | --- |"];
  for (const finding of sorted.slice(0, rows)) {
    const range =
      finding.start_line === undefined || finding.start_line === finding.line
        ? `${finding.line}`
        : `${finding.start_line}\\-${finding.line}`;
    const where = `${inline(finding.path)}:${range}`;
    lines.push(
      `| ${SEVERITY_TEXT[finding.severity]} | ${where} | ${inline(clip(finding.title, 200))} |`,
    );
  }
  if (sorted.length > rows) lines.push("", `…and ${count(sorted.length - rows, "more finding")}.`);
  return lines.join("\n");
}

/** Facts about the files, worked out once per render rather than at every detail level. */
interface Context {
  review: Map<string, string>;
  counts: Map<FileDiff, { added: number; removed: number }>;
}

function sumCounts(files: readonly FileDiff[], ctx: Context): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    const counts = ctx.counts.get(file);
    added += counts?.added ?? 0;
    removed += counts?.removed ?? 0;
  }
  return { added, removed };
}

function fileRow(file: FileDiff, ctx: Context): string {
  const { added, removed } = ctx.counts.get(file) ?? { added: 0, removed: 0 };
  const lines = file.binary ? "binary" : `+${added} −${removed}`;
  return `| ${pathText(file)} | ${file.status} | ${lines} | ${ctx.review.get(file.path) ?? "not planned"} |`;
}

function renderChanges(input: SummaryInput, ctx: Context, detail: Detail): string {
  const files = [...input.files].sort((a, b) => byPath(a.path, b.path));
  const totals = sumCounts(files, ctx);
  const lines = [
    "### Changes",
    "",
    `${count(files.length, "file")} changed, +${totals.added} −${totals.removed}.`,
  ];
  if (!detail.fileTable || files.length === 0) return lines.join("\n");

  if (files.length <= GROUP_FILES_OVER) {
    lines.push("", "| File | Status | Lines | Review |", "| --- | --- | --- | --- |");
    for (const file of files) lines.push(fileRow(file, ctx));
    return lines.join("\n");
  }

  const groups = new Map<string, FileDiff[]>();
  for (const file of files) {
    const key = groupOf(file.path);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  lines.push("", "| Folder | Files | Lines |", "| --- | --- | --- |");
  for (const [key, members] of [...groups].sort(([a], [b]) => byPath(a, b))) {
    const sum = sumCounts(members, ctx);
    lines.push(`| ${inline(key)} | ${members.length} | +${sum.added} −${sum.removed} |`);
  }
  if (!detail.fileRows) return lines.join("\n");
  for (const [key, members] of [...groups].sort(([a], [b]) => byPath(a, b))) {
    // A Markdown heading, not <details>: inside an HTML block backslash escapes don't apply, so a
    // folder name could add HTML there.
    lines.push(
      "",
      `#### ${inline(key)} (${count(members.length, "file")})`,
      "",
      "| File | Status | Lines | Review |",
      "| --- | --- | --- | --- |",
      ...members.map((file) => fileRow(file, ctx)),
    );
  }
  return lines.join("\n");
}

function renderTickets(tickets: TicketCoverage): string {
  const lines = [`### Ticket coverage (${inline(clip(tickets.provider, 50))})`, ""];
  if (tickets.tickets.length === 0) {
    lines.push("No linked tickets.");
    return lines.join("\n");
  }
  lines.push("| Ticket | Coverage | Notes |", "| --- | --- | --- |");
  for (const ticket of tickets.tickets.slice(0, LIST_LIMIT)) {
    const name = `${link(clip(ticket.key, 50), ticket.url)} ${inline(clip(ticket.title, 120))}`;
    const missing = ticket.missing ?? [];
    const notes = [
      ...(ticket.note === undefined || ticket.note === "" ? [] : [inline(clip(ticket.note, 300))]),
      ...missing.slice(0, MISSING_PER_TICKET).map((text) => `Missing: ${inline(clip(text, 200))}`),
      ...(missing.length > MISSING_PER_TICKET
        ? [`…and ${count(missing.length - MISSING_PER_TICKET, "more missing requirement")}`]
        : []),
    ];
    lines.push(`| ${name} | ${COVERAGE_TEXT[ticket.coverage]} | ${notes.join("<br>")} |`);
  }
  if (tickets.tickets.length > LIST_LIMIT) {
    lines.push("", `…and ${count(tickets.tickets.length - LIST_LIMIT, "more ticket")}.`);
  }
  if (tickets.footnote !== undefined) lines.push("", `_${tickets.footnote}_`);
  return lines.join("\n");
}

/** How each file was handled, for the changes table. */
function reviewColumn(plan: SummaryInput["plan"]): Map<string, string> {
  const review = new Map<string, string>();
  for (const planned of plan.files) review.set(planned.file.path, DEPTH_TEXT[planned.depth]);
  for (const skipped of plan.skipped) {
    review.set(
      skipped.file.path,
      skipped.newCode === true
        ? `skipped (${SKIP_TEXT[skipped.reason]}, new code)`
        : `skipped (${SKIP_TEXT[skipped.reason]})`,
    );
  }
  return review;
}

/** Most providers listed in the usage footer; a deploy config rarely has more. */
const USAGE_LIMIT = 10;

/** `12.3k`, `1.2M`: token counts short enough for a footer line. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/**
 * The footer: per provider, tokens in and out, cost when there was one, and limit hits and
 * fallbacks when there were any. Provider ids come from the deploy config, but are escaped all
 * the same.
 */
function renderUsage(usage: readonly ProviderUsage[]): string | undefined {
  if (usage.length === 0) return undefined;
  const parts = usage.slice(0, USAGE_LIMIT).map((entry) => {
    const details = [`${compact(entry.inputTokens)} in, ${compact(entry.outputTokens)} out`];
    if (entry.costUsd > 0) details.push(`$${entry.costUsd.toFixed(2)}`);
    if (entry.limitHits > 0) details.push(count(entry.limitHits, "limit hit"));
    if (entry.fallbacks > 0) details.push(count(entry.fallbacks, "fallback"));
    return `${inline(clip(entry.providerId, 50))} (${details.join(", ")})`;
  });
  if (usage.length > USAGE_LIMIT) parts.push(`${usage.length - USAGE_LIMIT} more`);
  // Plain Markdown, not <sub>: inside HTML, backslash escapes may not apply.
  return `_Model usage: ${parts.join(" · ")}_`;
}

function renderAt(
  input: SummaryInput,
  ctx: Context,
  detail: Detail,
  cut: readonly string[],
): string {
  const sections = ["## LGTMoose review"];
  const walkthrough = input.walkthrough?.trim() ?? "";
  if (detail.walkthrough && walkthrough !== "") {
    sections.push(
      ["### Walkthrough", "", paragraphs(clip(walkthrough, WALKTHROUGH_LIMIT))].join("\n"),
    );
  }
  sections.push(renderChanges(input, ctx, detail));
  sections.push(renderStatus(input));
  const findings = renderFindings(input.findings, detail.findingRows);
  if (findings !== undefined) sections.push(findings);
  if (input.tickets !== undefined) sections.push(renderTickets(input.tickets));
  const usage = renderUsage(input.usage ?? []);
  if (usage !== undefined) sections.push(usage);
  if (cut.length > 0) {
    sections.push(`_Left out to stay under GitHub's comment size limit: ${cut.join(", ")}._`);
  }
  return `${sections.join("\n\n")}\n`;
}

/** What a detail level leaves out compared with the full comment, for the note at the end. */
function cutAt(input: SummaryInput, detail: Detail): string[] {
  const cut: string[] = [];
  if (!detail.walkthrough && (input.walkthrough?.trim() ?? "") !== "") cut.push("the walkthrough");
  if (!detail.fileTable) cut.push("the file table");
  else if (!detail.fileRows && input.files.length > GROUP_FILES_OVER) cut.push("the per-file rows");
  if (input.findings.length > detail.findingRows) {
    cut.push(detail.findingRows === 0 ? "the findings list" : "part of the findings list");
  }
  return cut;
}

const CUT_NOTE =
  "\n_The rest of this comment was cut to stay under GitHub's comment size limit._\n";

/**
 * Last resort when even the least detailed comment is too long (very long ticket lists, say):
 * keeps whole lines from the top, where the outcome is, and says the rest was cut. Cutting at a
 * line keeps every escape and table row intact.
 */
function cutToFit(text: string, max: number): string {
  const room = max - CUT_NOTE.length - 1;
  if (room <= 0) return text.slice(0, Math.max(0, max));
  const end = text.lastIndexOf("\n", room);
  return `${text.slice(0, end > 0 ? end : room)}\n${CUT_NOTE}`;
}

/**
 * Renders the PR's summary comment from review data. It's a pure function of its input, with no
 * hidden markers: the poster finds the comment to edit by the ID it stored, and the same data
 * always gives the same comment. Untrusted text (the walkthrough, paths, finding titles,
 * lockfile notes, ticket titles) is escaped so it can't add formatting, HTML, links or mentions.
 *
 * The comment stays under GitHub's limit: when it's too long, the walkthrough, per-file rows and
 * findings list are dropped in turn, and the comment says what was left out.
 */
export function renderSummary(input: SummaryInput, options: RenderOptions = {}): string {
  const max = options.maxLength ?? GITHUB_COMMENT_LIMIT;
  const ctx: Context = {
    review: reviewColumn(input.plan),
    counts: new Map(input.files.map((file) => [file, lineCounts(file)])),
  };
  let last = "";
  for (const detail of DETAIL_LEVELS) {
    last = renderAt(input, ctx, detail, cutAt(input, detail));
    if (last.length <= max) return last;
  }
  return cutToFit(last, max);
}
