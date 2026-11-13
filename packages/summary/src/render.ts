import { SEVERITIES, severityRank, type Finding, type Severity } from "@lgtmoose/core";
import type { FileDiff } from "@lgtmoose/git";
import type { Plan, ReadingDepth, SkipReason, SkippedFile } from "@lgtmoose/planner";
import { clip, inline, link, paragraphs } from "./markdown.js";

/** GitHub refuses issue and PR comments longer than this. */
export const GITHUB_COMMENT_LIMIT = 65_536;

/** The review event the decision maps to. */
export type ReviewEvent = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

export interface SummaryDecision {
  event: ReviewEvent;
  /** The status label the PR should carry, from `labels` in .lgtmoose.yaml. */
  label: string;
  /**
   * Why the decision is weaker than the findings alone would give, such as "the review didn't
   * finish" or "the head moved during the run". Shown as written: plain code text, not PR text.
   */
  reasons?: readonly string[];
}

export type TicketCoverageLevel = "covered" | "partial" | "not_covered";

export interface TicketCoverage {
  /** The ticket provider's name, such as Linear. */
  provider: string;
  tickets: readonly {
    key: string;
    title: string;
    url?: string;
    coverage: TicketCoverageLevel;
    note?: string;
  }[];
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
  /** Findings past the per-run limit that were dropped, least severe first. */
  findingsOverLimit?: number;
  /** Status labels the repo doesn't have (from `syncStatusLabel`), so they couldn't be set. */
  missingLabels?: readonly string[];
}

export interface RenderOptions {
  /** Longest comment allowed. Defaults to GitHub's limit. */
  maxLength?: number;
}

/** More files than this and the changes table is grouped by folder. */
export const GROUP_FILES_OVER = 10;

const LIST_LIMIT = 25;
const NOTES_PER_LOCKFILE = 10;
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
};

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
  const shown = items.slice(0, limit).map((item) => `  - ${item}`);
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
      ...bullets(newCode.map((entry) => inline(entry.file.path))),
    );
  }

  const noted = skipped.filter(
    (entry): entry is SkippedFile & { notes: string[] } => (entry.notes?.length ?? 0) > 0,
  );
  if (noted.length > 0) {
    lines.push("- **Dependency changes to check:**");
    for (const entry of noted.slice(0, LIST_LIMIT)) {
      lines.push(`  - ${inline(entry.file.path)}`);
      lines.push(
        ...bullets(
          entry.notes.map((note) => inline(note)),
          NOTES_PER_LOCKFILE,
        ).map((l) => `  ${l}`),
      );
    }
    if (noted.length > LIST_LIMIT) lines.push(`  - …and ${noted.length - LIST_LIMIT} more files`);
  }

  const omitted = input.conventionFilesOmitted ?? [];
  if (omitted.length > 0) {
    lines.push(
      `- **Convention files left out** (over the size limit): ${count(omitted.length, "file")}`,
      ...bullets(omitted.map((path) => inline(path))),
    );
  }

  lines.push(`- **Decision:** ${EVENT_TEXT[input.decision.event]}`);
  for (const reason of input.decision.reasons ?? []) lines.push(`  - ${inline(reason)}`);
  lines.push(`- **Label:** ${inline(input.decision.label)}`);
  const missing = input.missingLabels ?? [];
  if (missing.length > 0) {
    lines.push(
      `  - The repository has no ${missing.map((label) => inline(label)).join(", ")} label. LGTMoose doesn't create labels; add them in the repository's settings.`,
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
    const where = `${inline(finding.path)}:${finding.start_line === undefined ? "" : `${finding.start_line}\\-`}${finding.line}`;
    lines.push(
      `| ${SEVERITY_TEXT[finding.severity]} | ${where} | ${inline(clip(finding.title, 200))} |`,
    );
  }
  if (sorted.length > rows) lines.push("", `…and ${count(sorted.length - rows, "more finding")}.`);
  return lines.join("\n");
}

function fileRow(file: FileDiff, review: Map<string, string>): string {
  const { added, removed } = lineCounts(file);
  return `| ${pathText(file)} | ${file.status} | +${added} −${removed} | ${review.get(file.path) ?? "not planned"} |`;
}

function renderChanges(input: SummaryInput, review: Map<string, string>, detail: Detail): string {
  const files = [...input.files].sort((a, b) => byPath(a.path, b.path));
  const totals = files.reduce(
    (sum, file) => {
      const { added, removed } = lineCounts(file);
      return { added: sum.added + added, removed: sum.removed + removed };
    },
    { added: 0, removed: 0 },
  );
  const lines = [
    "### Changes",
    "",
    `${count(files.length, "file")} changed, +${totals.added} −${totals.removed}.`,
  ];
  if (!detail.fileTable || files.length === 0) return lines.join("\n");

  if (files.length <= GROUP_FILES_OVER) {
    lines.push("", "| File | Status | Lines | Review |", "| --- | --- | --- | --- |");
    for (const file of files) lines.push(fileRow(file, review));
    return lines.join("\n");
  }

  const groups = new Map<string, FileDiff[]>();
  for (const file of files) {
    const key = groupOf(file.path);
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  lines.push("", "| Folder | Files | Lines |", "| --- | --- | --- |");
  for (const [key, members] of [...groups].sort(([a], [b]) => byPath(a, b))) {
    const sum = members.reduce(
      (acc, file) => {
        const { added, removed } = lineCounts(file);
        return { added: acc.added + added, removed: acc.removed + removed };
      },
      { added: 0, removed: 0 },
    );
    lines.push(`| ${inline(key)} | ${members.length} | +${sum.added} −${sum.removed} |`);
  }
  if (!detail.fileRows) return lines.join("\n");
  for (const [key, members] of [...groups].sort(([a], [b]) => byPath(a, b))) {
    lines.push(
      "",
      `<details><summary>${inline(key)} (${count(members.length, "file")})</summary>`,
      "",
      "| File | Status | Lines | Review |",
      "| --- | --- | --- | --- |",
      ...members.map((file) => fileRow(file, review)),
      "",
      "</details>",
    );
  }
  return lines.join("\n");
}

function renderTickets(tickets: TicketCoverage): string {
  const lines = [`### Ticket coverage (${inline(tickets.provider)})`, ""];
  if (tickets.tickets.length === 0) {
    lines.push("No linked tickets.");
    return lines.join("\n");
  }
  lines.push("| Ticket | Coverage | Notes |", "| --- | --- | --- |");
  for (const ticket of tickets.tickets.slice(0, LIST_LIMIT)) {
    const name = `${link(ticket.key, ticket.url)} ${inline(clip(ticket.title, 120))}`;
    lines.push(
      `| ${name} | ${COVERAGE_TEXT[ticket.coverage]} | ${inline(clip(ticket.note ?? "", 300))} |`,
    );
  }
  if (tickets.tickets.length > LIST_LIMIT) {
    lines.push("", `…and ${count(tickets.tickets.length - LIST_LIMIT, "more ticket")}.`);
  }
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

function renderAt(input: SummaryInput, detail: Detail, cut: readonly string[]): string {
  const review = reviewColumn(input.plan);
  const sections = ["## LGTMoose review"];
  const walkthrough = input.walkthrough?.trim() ?? "";
  if (detail.walkthrough && walkthrough !== "") {
    sections.push(
      ["### Walkthrough", "", paragraphs(clip(walkthrough, WALKTHROUGH_LIMIT))].join("\n"),
    );
  }
  sections.push(renderChanges(input, review, detail));
  sections.push(renderStatus(input));
  const findings = renderFindings(input.findings, detail.findingRows);
  if (findings !== undefined) sections.push(findings);
  if (input.tickets !== undefined) sections.push(renderTickets(input.tickets));
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
  let last = "";
  for (const detail of DETAIL_LEVELS) {
    last = renderAt(input, detail, cutAt(input, detail));
    if (last.length <= max) return last;
  }
  // The least detailed form is bounded by its list limits; this only trips on a tiny maxLength.
  return `${last.slice(0, Math.max(0, max - 2))}…\n`;
}
