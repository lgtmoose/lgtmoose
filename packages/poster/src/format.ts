import type { Finding, Severity } from "@lgtmoose/core";
import { clip, inline, paragraphs } from "@lgtmoose/summary";

const SEVERITY_TEXT: Record<Severity, string> = {
  blocking: "Blocking",
  should_fix: "Should fix",
  nit: "Nit",
};

/** GitHub refuses comment and review bodies longer than this. */
export const GITHUB_BODY_LIMIT = 65_536;

/** A fence longer than any run of backticks in the text, so the text can't close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * A suggestion block: replacement code GitHub offers to apply. The code is not escaped (it's
 * shown as code), but the fence is longer than any backtick run in it, so it can't end the block
 * early and add Markdown after it.
 */
export function suggestionBlock(code: string): string {
  const text = code.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const fence = fenceFor(text);
  return `${fence}suggestion\n${text}\n${fence}`;
}

/** The heading line of a finding: severity, then the title. */
export function findingHeading(finding: Finding): string {
  return `**${SEVERITY_TEXT[finding.severity]}:** ${inline(clip(finding.title, 200))}`;
}

/**
 * An inline review comment for a finding: severity and title, the body as plain paragraphs, and
 * a suggestion block when the finding has one. The title and body are model output about PR
 * text, so they are escaped: they can't add links, mentions, HTML or formatting.
 */
export function formatComment(finding: Finding, options: { suggestion?: boolean } = {}): string {
  const parts = [findingHeading(finding), paragraphs(finding.body)];
  if (options.suggestion !== false && finding.suggestion !== undefined) {
    parts.push(suggestionBlock(finding.suggestion));
  }
  return clip(parts.join("\n\n"), GITHUB_BODY_LIMIT);
}

/** `path:line` (or `path:start-end`), escaped, for a finding listed in the review body. */
export function findingLocation(finding: Finding): string {
  const range =
    finding.start_line === undefined || finding.start_line === finding.line
      ? `${finding.line}`
      : `${finding.start_line}\\-${finding.line}`;
  const side = finding.side === "LEFT" ? " (old version)" : "";
  return `${inline(finding.path)}:${range}${side}`;
}
