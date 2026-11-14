import { severityRank, type Finding, type ReviewEvent } from "@lgtmoose/core";
import { commentTarget, type CommentPosition, type FileDiff } from "@lgtmoose/git";
import { clip, paragraphs } from "@lgtmoose/summary";
import { GITHUB_BODY_LIMIT, findingHeading, findingLocation, formatComment } from "./format.js";

/** One inline comment in a review, as GitHub's "create a review" API takes it. */
export interface ReviewComment extends CommentPosition {
  body: string;
}

export interface ReviewInput {
  event: ReviewEvent;
  /** Findings to post inline (see `placeFindings` in @lgtmoose/roles). */
  inline: readonly Finding[];
  /** Findings that can't go inline: listed in the review body as `path:line`. */
  outsideDiff: readonly Finding[];
  /** The PR's files, for the comment positions. */
  files: readonly FileDiff[];
  /** Most nits posted in one review (`gate.nit_cap`). The rest are counted, not posted. */
  nitCap: number;
  /** A line or two for the top of the review body, such as a link to the summary comment. */
  intro?: string;
  /**
   * Text for a hidden HTML comment at the end of the body, so the poster can find this review
   * again (say, the run's ID). Letters, digits, `-`, `_` and `:` only.
   */
  marker?: string;
}

export interface ReviewPayload {
  event: ReviewEvent;
  /** Never empty: GitHub refuses a COMMENT or REQUEST_CHANGES review without a body. */
  body: string;
  comments: ReviewComment[];
  /** The findings behind `comments`, in the same order. */
  commented: Finding[];
  /** Findings in the body because they can't go inline. */
  inBody: Finding[];
  /** Nits past `nitCap`, left out. */
  nitsLeftOut: number;
  /** The intro the body starts with, kept so a retry rebuilds the same body. */
  intro?: string;
  /** The hidden marker at the end of the body, kept for the same reason. */
  marker?: string;
}

/** The hidden comment a marked review's body ends with. */
export function reviewMarkerComment(marker: string): string {
  if (!/^[\w:-]{1,100}$/.test(marker))
    throw new Error("A review marker is letters, digits, -, _ and :.");
  return `<!-- ${marker} -->`;
}

function withMarker(body: string, marker: string | undefined): string {
  return marker === undefined ? body : `${body}\n\n${reviewMarkerComment(marker)}`;
}

/**
 * The body's first line when the caller gives no intro. A COMMENT review isn't always about
 * comments: decide() also posts one with no findings when the review didn't finish, approvals
 * are off or the head moved, so without findings it only says the PR wasn't approved.
 */
function defaultIntro(event: ReviewEvent, findings: number): string {
  if (event === "APPROVE") return "LGTMoose found nothing that needs changing.";
  if (event === "REQUEST_CHANGES") {
    return "LGTMoose found problems that should be fixed before merging.";
  }
  return findings > 0
    ? "LGTMoose left comments; none of them block the merge."
    : "LGTMoose reviewed this pull request and didn't approve it; the summary comment says why.";
}

/**
 * Keeps at most `cap` nits, in order, and every other finding. The cap counts nits across the
 * whole review, inline and in the body alike.
 */
function capNits(
  inline: readonly Finding[],
  outside: readonly Finding[],
  cap: number,
): { inline: Finding[]; outside: Finding[]; left: number } {
  let room = Math.max(0, cap);
  let left = 0;
  const keep = (finding: Finding) => {
    if (finding.severity !== "nit") return true;
    if (room > 0) {
      room -= 1;
      return true;
    }
    left += 1;
    return false;
  };
  // Inline nits are kept before body ones: they sit on the line they're about.
  const keptInline = inline.filter(keep);
  const keptOutside = outside.filter(keep);
  return { inline: keptInline, outside: keptOutside, left };
}

/** One finding as a body list item: where, what, and the body. */
function bodyItem(finding: Finding): string {
  return `- ${findingLocation(finding)}: ${findingHeading(finding)}\n\n${indent(paragraphs(finding.body))}`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}

/** Room kept for the closing lines (more findings, nits left out) when the body is full. */
const TAIL_ROOM = 500;

/**
 * The review body: the outcome, findings that can't go inline (most severe first), and nits
 * left out. Findings are added while they fit under GitHub's limit; any that don't are counted
 * in a closing line rather than cut off silently.
 */
export function reviewBody(
  event: ReviewEvent,
  inBody: readonly Finding[],
  nitsLeftOut: number,
  intro?: string,
  inlineCount = 0,
): string {
  const head = clip(intro?.trim() || defaultIntro(event, inBody.length + inlineCount), 2_000);
  const parts = [head];
  let length = head.length;
  if (inBody.length > 0) {
    const sorted = [...inBody].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    const items: string[] = [];
    for (const finding of sorted) {
      const item = bodyItem(finding);
      if (length + item.length + 2 > GITHUB_BODY_LIMIT - TAIL_ROOM) break;
      items.push(item);
      length += item.length + 2;
    }
    parts.push(["**Findings not shown inline**", "", ...items].join("\n"));
    const more = sorted.length - items.length;
    if (more > 0) {
      parts.push(
        `…and ${more} more ${more === 1 ? "finding" : "findings"} that didn't fit in this review.`,
      );
    }
  }
  if (nitsLeftOut > 0) {
    parts.push(
      `${nitsLeftOut} more ${nitsLeftOut === 1 ? "nit was" : "nits were"} left out (the review posts at most \`gate.nit_cap\` nits).`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Builds the one review a run posts. Each inline finding gets a comment at the position
 * `commentTarget` gives; one whose lines aren't in a hunk of its file (or whose file isn't in
 * the PR) goes into the body as `path:line`, with the findings that were already outside the
 * diff. Nits past `nitCap` are counted and left out. Suggestions are only offered on the new
 * version of a file, where GitHub can apply them.
 */
export function buildReview(input: ReviewInput): ReviewPayload {
  const files = new Map(input.files.map((file) => [file.path, file]));
  const capped = capNits(input.inline, input.outsideDiff, input.nitCap);
  const comments: ReviewComment[] = [];
  const commented: Finding[] = [];
  const inBody: Finding[] = [...capped.outside];
  for (const finding of capped.inline) {
    const file = files.get(finding.path);
    const target =
      file === undefined
        ? undefined
        : commentTarget(file, finding.line, {
            side: finding.side,
            ...(finding.start_line === undefined ? {} : { startLine: finding.start_line }),
          });
    if (target === undefined || !target.inHunk) {
      inBody.push(finding);
      continue;
    }
    comments.push({
      ...target.position,
      body: formatComment(finding, { suggestion: finding.side === "RIGHT" }),
    });
    commented.push(finding);
  }
  return {
    event: input.event,
    body: withMarker(
      reviewBody(input.event, inBody, capped.left, input.intro, comments.length),
      input.marker,
    ),
    comments,
    commented,
    inBody,
    nitsLeftOut: capped.left,
    ...(input.intro === undefined ? {} : { intro: input.intro }),
    ...(input.marker === undefined ? {} : { marker: input.marker }),
  };
}

/**
 * The same review with every inline comment moved into the body, for when GitHub refuses a
 * comment position (HTTP 422 doesn't say which one).
 */
export function withCommentsInBody(payload: ReviewPayload): ReviewPayload {
  const inBody = [...payload.inBody, ...payload.commented];
  return {
    ...payload,
    body: withMarker(
      reviewBody(payload.event, inBody, payload.nitsLeftOut, payload.intro),
      payload.marker,
    ),
    comments: [],
    commented: [],
    inBody,
  };
}
