import { severityRank, type Finding } from "@lgtmoose/core";
import { commentTarget, type CommentPosition, type FileDiff } from "@lgtmoose/git";
import { clip, paragraphs } from "@lgtmoose/summary";
import { GITHUB_BODY_LIMIT, findingHeading, findingLocation, formatComment } from "./format.js";

/** The review event posted to GitHub. */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

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
}

const EVENT_TEXT: Record<ReviewEvent, string> = {
  APPROVE: "LGTMoose found nothing that needs changing.",
  COMMENT: "LGTMoose left comments; none of them block the merge.",
  REQUEST_CHANGES: "LGTMoose found problems that should be fixed before merging.",
};

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

/** The body list of findings that couldn't go inline, most severe first. */
function bodyList(findings: readonly Finding[]): string {
  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const items = sorted.map(
    (finding) =>
      `- ${findingLocation(finding)}: ${findingHeading(finding)}\n\n${indent(paragraphs(finding.body))}`,
  );
  return ["**Findings outside the diff**", "", ...items].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");
}

/** The review body: the outcome, findings that can't go inline, and nits left out. */
export function reviewBody(
  event: ReviewEvent,
  inBody: readonly Finding[],
  nitsLeftOut: number,
  intro?: string,
): string {
  const parts = [intro?.trim() || EVENT_TEXT[event]];
  if (inBody.length > 0) parts.push(bodyList(inBody));
  if (nitsLeftOut > 0) {
    parts.push(
      `${nitsLeftOut} more ${nitsLeftOut === 1 ? "nit was" : "nits were"} left out (the review posts at most \`gate.nit_cap\` nits).`,
    );
  }
  return clip(parts.join("\n\n"), GITHUB_BODY_LIMIT);
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
    body: reviewBody(input.event, inBody, capped.left, input.intro),
    comments,
    commented,
    inBody,
    nitsLeftOut: capped.left,
  };
}

/**
 * The same review with every inline comment moved into the body, for when GitHub refuses a
 * comment position (HTTP 422 doesn't say which one).
 */
export function withCommentsInBody(payload: ReviewPayload, intro?: string): ReviewPayload {
  const inBody = [...payload.inBody, ...payload.commented];
  return {
    ...payload,
    body: reviewBody(payload.event, inBody, payload.nitsLeftOut, intro),
    comments: [],
    commented: [],
    inBody,
  };
}
