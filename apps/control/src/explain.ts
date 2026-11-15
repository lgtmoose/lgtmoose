import { explanationSchema, type Explanation, type Severity } from "@lgtmoose/core";
import type { Repo } from "@lgtmoose/git";
import {
  batchOutputSchema,
  headKeys,
  runKeys,
  scanText,
  type InjectionKind,
} from "@lgtmoose/pipeline";
import { buildExplainPrompt, codeExcerpt } from "@lgtmoose/roles";
import { inline, paragraphs } from "@lgtmoose/summary";
import { z } from "zod";
import type { ArtifactStore, ControlDeps, FindingRecord } from "./ports.js";
import { JUDGE_REPLY_MARKER, type PendingKind, type ReplyStore } from "./replies.js";

/**
 * `@lgtmoose explain` answered by a model (NIC-1053), on the reply judge's path:
 *
 * - **The conversation Lambda** checks who asked (the PR's author or someone with write
 *   access), records the request in `pending_replies` (`kind` `explain` or `explain_pr`) and
 *   asks for a run (`requested: "explain"`). It has no model credential.
 * - **Prepare** (`explainJobs`) takes up to `maxExplanations` pending explains, each finding's
 *   latest, and adds an explainer batch per finding on the fast tier, unless an earlier run at
 *   this head already answered it (`headKeys().explanation`): then that answer is reused, so
 *   the model runs at most once per finding per head.
 * - **The sandbox** runs the explainer with the checkout, no GitHub token and only its
 *   provider's leased credential. Its output is `explanationSchema`: text and a line, nothing
 *   that acts.
 * - **Post** (`answerExplanations`) scans the answer with the prompt-injection detector, keeps
 *   it for later runs at this head, and replies with it escaped. A flagged answer, or none (the
 *   model failed or is unavailable), falls back to the finding as it's stored, the reply
 *   `explain` gave before.
 */

/** The longest an explainer run may take: it reads one finding's file, on the fast tier. */
export const EXPLAIN_TIMEOUT_MS = 5 * 60_000;

/** The most explains answered by a model per PR per run, unless the deploy config says otherwise. */
export const DEFAULT_MAX_EXPLANATIONS = 5;

/** Lines of code either side of the finding's line in the explainer's prompt. */
const EXCERPT_CONTEXT = 15;

/** A finding as `explain` describes it: what the database has (trusted). */
export interface ExplainedFinding {
  severity: Severity;
  ruleCategory: string;
  title: string;
  body: string;
  path: string | undefined;
  line: number | undefined;
  status: string;
  raisedAtSha: string;
}

const short = (sha: string) => sha.slice(0, 7);

function where(finding: Pick<ExplainedFinding, "path" | "line">): string {
  return finding.path === undefined
    ? "the whole PR"
    : `${inline(finding.path)}${finding.line === undefined ? "" : `:${finding.line}`}`;
}

/** A finding as a short Markdown block: its fields escaped, its text as plain paragraphs. */
export function describeFinding(finding: ExplainedFinding): string {
  return [
    `**${inline(finding.title)}**`,
    "",
    `Severity: ${finding.severity}. Category: ${inline(finding.ruleCategory)}. Where: ${where(finding)}. Status: ${finding.status}. Raised at ${short(finding.raisedAtSha)}.`,
    "",
    paragraphs(finding.body),
  ].join("\n");
}

/** The explainer's answer as a reply: escaped, so it can't mention anyone or link anything. */
export function explanationReply(finding: ExplainedFinding, explanation: Explanation): string {
  const see =
    explanation.line === undefined || finding.path === undefined
      ? []
      : ["", `See ${inline(finding.path)} line ${explanation.line}.`];
  return [
    `**${inline(finding.title)}** (${where(finding)})`,
    "",
    paragraphs(explanation.text),
    ...see,
  ].join("\n");
}

/**
 * One `explain` this run answers: where the answer goes, and the finding as the database has it
 * for the fallback. Written by the prepare step (trusted), not by the model.
 */
export interface ExplainJob {
  replyId: string;
  findingId: string;
  /** The comment that asked: a review comment, or for `explain_pr` an issue comment. */
  commentId: number;
  author: string;
  /** In the finding's thread (`explain`), or on the PR (`explain_pr`). */
  kind: Exclude<PendingKind, "reply">;
  /** The finding's inline comment: the thread an `explain` answer goes in. */
  threadRootId?: number;
  finding: ExplainedFinding;
  /** Its explainer batch in this run. Left out when an earlier run's answer is reused. */
  index?: number;
  /** An earlier run's answer at this head. */
  cached?: CachedExplanation;
}

const cachedSchema = z.object({
  version: z.literal(1),
  explanation: explanationSchema.optional(),
  /** What the prompt-injection detector flagged in the answer: it's never posted. */
  flagged: z.array(z.string()).optional(),
});

export type CachedExplanation = z.infer<typeof cachedSchema>;

async function readCached(
  store: ArtifactStore,
  key: string,
): Promise<CachedExplanation | undefined> {
  const text = await store.getText(key);
  if (text === undefined) return undefined;
  try {
    const parsed = cachedSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The code around the finding's line when it was raised, when git has it. */
async function excerptAt(repo: Repo, record: FindingRecord) {
  if (record.side !== "RIGHT") return undefined;
  try {
    await repo.fetchCommits([record.raisedAtSha]);
    const text = await repo.git(["show", `${record.raisedAtSha}:${record.path}`]);
    return codeExcerpt(
      text.split("\n"),
      {
        line: record.line,
        ...(record.startLine === undefined ? {} : { start_line: record.startLine }),
      },
      EXCERPT_CONTEXT,
    );
  } catch {
    return undefined;
  }
}

/**
 * The explains this run answers: the PR's pending ones (each finding's latest, oldest first,
 * up to `limit`) on findings still open or outdated, each with a batch index from `firstIndex`
 * and its prompt, or an earlier run's answer at this head. One on a finding closed since is
 * skipped. Runs before the checkout is sealed: the excerpt needs the finding's commit.
 */
export async function explainJobs(
  deps: Pick<ControlDeps, "findings" | "store" | "log"> & { replies?: ReplyStore },
  input: {
    pullRequestId: string;
    limit: number;
    repo: Repo;
    /** owner/name. */
    repoName: string;
    prNumber: number;
    headSha: string;
    firstIndex: number;
  },
): Promise<(ExplainJob & { prompt?: string })[]> {
  const { replies } = deps;
  if (replies === undefined || input.limit <= 0) return [];
  const pending = await replies.take(input.pullRequestId, input.limit, "explain");
  if (pending.length === 0) return [];
  const open = new Map(
    (await deps.findings.trackedFindings(input.pullRequestId)).map((record) => [record.id, record]),
  );
  const keys = headKeys(input.repoName, input.prNumber, input.headSha);
  const jobs: (ExplainJob & { prompt?: string })[] = [];
  const gone: string[] = [];
  let next = input.firstIndex;
  for (const request of pending) {
    const record = open.get(request.findingId);
    if (record === undefined) {
      gone.push(request.id);
      continue;
    }
    const job: ExplainJob = {
      replyId: request.id,
      findingId: record.id,
      commentId: request.commentId,
      author: request.author,
      kind: request.kind === "explain" ? "explain" : "explain_pr",
      ...(record.githubCommentId === undefined ? {} : { threadRootId: record.githubCommentId }),
      finding: {
        severity: record.severity,
        ruleCategory: record.ruleCategory,
        title: record.title,
        body: record.body,
        path: record.path,
        line: record.line,
        status: record.status,
        raisedAtSha: record.raisedAtSha,
      },
    };
    const cached = await readCached(deps.store, keys.explanation(record.id));
    if (cached !== undefined) {
      jobs.push({ ...job, cached });
      continue;
    }
    const excerpt = await excerptAt(input.repo, record);
    jobs.push({
      ...job,
      index: next,
      prompt: buildExplainPrompt({
        finding: {
          severity: record.severity,
          ruleCategory: record.ruleCategory,
          title: record.title,
          body: record.body,
          path: record.path,
          line: record.line,
          side: record.side,
          raisedAtSha: record.raisedAtSha,
        },
        ...(excerpt === undefined ? {} : { excerpt }),
        headSha: input.headSha,
      }),
    });
    next += 1;
  }
  if (gone.length > 0) await replies.finish(gone, "skipped");
  if (jobs.length > 0) {
    deps.log("findings to explain", {
      count: jobs.length,
      reused: jobs.filter((job) => job.cached !== undefined).length,
    });
  }
  return jobs;
}

/**
 * An explain batch's answer from its output object: undefined when there's no output, it
 * failed, or it doesn't validate. The sandbox ran a model on the finding and the code, so it's
 * checked like any model output.
 */
export async function readExplanation(
  store: ArtifactStore,
  runId: string,
  index: number,
): Promise<Explanation | undefined> {
  const text = await store.getText(runKeys(runId).batchOutput(index));
  if (text === undefined) return undefined;
  try {
    const parsed = batchOutputSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.index === index ? parsed.data.explanation : undefined;
  } catch {
    return undefined;
  }
}

/** What the injection detector flags in an answer, as it would be rendered. */
function flaggedKinds(explanation: Explanation): InjectionKind[] {
  return scanText(explanation.text, { markdown: true });
}

export interface AnswerDeps {
  store: ArtifactStore;
  /** In the thread whose first comment is `threadRootId`. */
  reply(threadRootId: number, body: string): Promise<void>;
  /** On the PR. */
  comment(body: string): Promise<void>;
  replies: Pick<ReplyStore, "finish">;
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Answers the run's explains: each with the explainer's answer, escaped, when there is one and
 * the injection detector passes it, or else with the finding as it's stored. An answer made
 * this run (or flagged) is kept for later runs at this head. Returns how many the model
 * answered.
 */
export async function answerExplanations(
  jobs: readonly ExplainJob[],
  run: { runId: string; repo: string; prNumber: number; headSha: string },
  deps: AnswerDeps,
): Promise<number> {
  const keys = headKeys(run.repo, run.prNumber, run.headSha);
  let answered = 0;
  for (const job of jobs) {
    let explanation = job.cached?.explanation;
    let flagged: readonly string[] | undefined = job.cached?.flagged;
    if (job.cached === undefined && job.index !== undefined) {
      explanation = await readExplanation(deps.store, run.runId, job.index);
      if (explanation !== undefined) {
        const kinds = flaggedKinds(explanation);
        if (kinds.length > 0) {
          flagged = kinds;
          explanation = undefined;
        }
        try {
          await deps.store.putText(
            keys.explanation(job.findingId),
            JSON.stringify(
              flagged === undefined ? { version: 1, explanation } : { version: 1, flagged },
            ),
          );
        } catch {
          // Not kept: the next explain of it at this head runs the model again.
        }
      }
    }
    // A cached answer was scanned before it was kept; scanned again, it costs nothing.
    if (explanation !== undefined && flaggedKinds(explanation).length > 0) explanation = undefined;
    deps.log("finding explained", {
      findingId: job.findingId,
      commentId: job.commentId,
      answered: explanation !== undefined,
      ...(flagged === undefined ? {} : { flagged }),
      reused: job.cached !== undefined,
    });
    const body = `${
      explanation === undefined
        ? describeFinding(job.finding)
        : explanationReply(job.finding, explanation)
    }\n\n${JUDGE_REPLY_MARKER}`;
    if (job.kind === "explain" && job.threadRootId !== undefined) {
      // To the thread's first comment: GitHub has no replies to replies.
      await deps.reply(job.threadRootId, body);
    } else {
      await deps.comment(body);
    }
    if (explanation !== undefined) answered += 1;
    await deps.replies.finish([job.replyId], "judged");
  }
  return answered;
}
