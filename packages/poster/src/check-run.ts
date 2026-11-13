import type { CheckConclusion, Finding, Severity } from "@lgtmoose/core";
import { clip } from "@lgtmoose/summary";

/** The check run's name on every PR. */
export const CHECK_NAME = "LGTMoose";

/** GitHub takes at most this many annotations per create or update request. */
export const ANNOTATIONS_PER_REQUEST = 50;

/** GitHub's limits on check-run output fields. */
const SUMMARY_LIMIT = 65_535;
const TEXT_LIMIT = 65_535;
const ANNOTATION_TITLE_LIMIT = 255;
const ANNOTATION_MESSAGE_LIMIT = 64 * 1024 - 1;

export type AnnotationLevel = "notice" | "warning" | "failure";

/** One check-run annotation, as GitHub's API takes it. */
export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: AnnotationLevel;
  title: string;
  message: string;
}

const LEVEL: Record<Severity, AnnotationLevel> = {
  blocking: "failure",
  should_fix: "warning",
  nit: "notice",
};

/**
 * Annotations for findings on the new version of a file. Annotations point at lines of the head
 * commit, so findings on deleted lines (LEFT) get none. They are plain text in GitHub's UI, so
 * nothing is escaped, only cut to GitHub's limits.
 */
export function annotationsFor(findings: readonly Finding[]): Annotation[] {
  return findings
    .filter((finding) => finding.side === "RIGHT")
    .map((finding) => ({
      path: finding.path,
      start_line: finding.start_line ?? finding.line,
      end_line: finding.line,
      annotation_level: LEVEL[finding.severity],
      title: clip(finding.title, ANNOTATION_TITLE_LIMIT),
      message: clip(finding.body, ANNOTATION_MESSAGE_LIMIT),
    }));
}

export interface CheckRunInput {
  headSha: string;
  conclusion: CheckConclusion;
  /** One line, such as "Changes requested: 2 blocking findings". */
  title: string;
  /** Markdown, such as the rendered summary. */
  summary: string;
  text?: string;
  annotations: readonly Annotation[];
  /**
   * Where a person should look, such as the summary comment's URL. Worth giving for
   * `action_required`, which asks someone to act.
   */
  detailsUrl?: string;
  /**
   * The in-progress run from `startCheckRun`, to complete instead of creating a new one. Updates
   * add to a run's annotations, so don't pass a run that already has them.
   */
  existingId?: number;
}

/** The output object for one request, with at most one page of annotations. */
export function checkOutput(
  input: Pick<CheckRunInput, "title" | "summary" | "text">,
  annotations: readonly Annotation[],
): Record<string, unknown> {
  return {
    title: clip(input.title, ANNOTATION_TITLE_LIMIT),
    summary: clip(input.summary, SUMMARY_LIMIT),
    ...(input.text === undefined ? {} : { text: clip(input.text, TEXT_LIMIT) }),
    ...(annotations.length === 0 ? {} : { annotations }),
  };
}

/** Splits annotations into the pages GitHub accepts per request. */
export function annotationPages(annotations: readonly Annotation[]): Annotation[][] {
  const pages: Annotation[][] = [];
  for (let i = 0; i < annotations.length; i += ANNOTATIONS_PER_REQUEST) {
    pages.push(annotations.slice(i, i + ANNOTATIONS_PER_REQUEST));
  }
  return pages;
}
