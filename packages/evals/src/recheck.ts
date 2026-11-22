import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fixedByRecheck, recheckJob } from "@lgtmoose/control/recheck";
import { isProtectedCategory, SEVERITIES } from "@lgtmoose/core";
import { cloneAtSha } from "@lgtmoose/git";
import type { Harness } from "@lgtmoose/harness";
import { runRecheck } from "@lgtmoose/pipeline";
import { z } from "zod";

const exec = promisify(execFile);

/**
 * Recheck evals (NIC-1120): does the recheck close a carried finding fixed in another file, and
 * keep one that still holds? Each scenario is three commits: a base, the commit a finding was
 * raised at, and a later commit. The later commit either fixes the problem away from the cited
 * line (`fixed`), or changes something nearby and leaves it (`holds`).
 *
 * The scenario runs the control task's own code: `recheckJob` picks the finding and builds the
 * prompt from a real clone, the recheck runs on the harness, and `fixedByRecheck` decides. The
 * score that matters most is a false close: a finding that still holds closed as fixed. Any one
 * fails a run. Without a model the test stands in a deterministic recheck, so CI checks the
 * plumbing; a model run measures the recheck itself.
 */

const repoPath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
    { message: "paths are relative to the repo, without `..`" },
  );

const files = z.record(repoPath, z.string());

export const recheckScenarioSchema = z
  .object({
    description: z.string().min(1),
    /** `fixed`: the later commit fixes the finding in another file. `holds`: it doesn't. */
    expect: z.enum(["fixed", "holds"]),
    base: files,
    /** Laid over the base: the commit the finding was raised at. */
    raised: files,
    /** Laid over that: the later commit. It mustn't touch the finding's cited lines. */
    later: files,
    finding: z
      .object({
        rule_category: z.string().min(1),
        severity: z.enum(SEVERITIES).exclude(["nit"]),
        path: repoPath,
        line: z.number().int().positive(),
        start_line: z.number().int().positive().optional(),
        title: z.string().min(1),
        body: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .refine((spec) => spec.raised[spec.finding.path] !== undefined, {
    message: "the finding's file is one the raised commit writes",
  });

export type RecheckScenarioSpec = z.infer<typeof recheckScenarioSchema>;
export interface RecheckScenario extends RecheckScenarioSpec {
  name: string;
}

/** Loads every `*.json` scenario under `root`, sorted by name. */
export async function loadRecheckScenarios(root: string): Promise<RecheckScenario[]> {
  const scenarios: RecheckScenario[] = [];
  for (const file of (await readdir(root)).sort()) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    const parsed = recheckScenarioSchema.safeParse(
      JSON.parse(await readFile(join(root, file), "utf8")),
    );
    if (!parsed.success) {
      throw new Error(`Recheck scenario ${name}: ${z.prettifyError(parsed.error)}`);
    }
    scenarios.push({ ...parsed.data, name });
  }
  return scenarios;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "LGTMoose evals",
  GIT_AUTHOR_EMAIL: "evals@lgtmoose.invalid",
  GIT_COMMITTER_NAME: "LGTMoose evals",
  GIT_COMMITTER_EMAIL: "evals@lgtmoose.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
}

async function writeTree(dir: string, tree: Record<string, string>): Promise<void> {
  const top = resolve(dir);
  for (const [path, text] of Object.entries(tree)) {
    const full = resolve(dir, path);
    if (!full.startsWith(`${top}${sep}`)) throw new Error(`${path} is outside the repo.`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
}

/** The three commits, pushed to a bare remote the clone reads over file://, as from GitHub. */
async function buildRepo(scenario: RecheckScenario, root: string) {
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  for (const key of ["uploadpack.allowFilter", "uploadpack.allowAnySHA1InWant"]) {
    await git(remote, "config", key, "true");
  }
  await exec("git", ["init", "--quiet", "--initial-branch=main", work]);
  await git(work, "config", "commit.gpgsign", "false");
  await git(work, "remote", "add", "origin", remote);
  const shas: string[] = [];
  for (const [i, tree] of [scenario.base, scenario.raised, scenario.later].entries()) {
    await writeTree(work, tree);
    await git(work, "add", "--all");
    await git(work, "commit", "--quiet", "--allow-empty", "-m", `commit ${i}`);
    shas.push(await git(work, "rev-parse", "HEAD"));
  }
  await git(work, "push", "--quiet", "--all", "origin");
  const [baseSha = "", raisedSha = "", headSha = ""] = shas;
  return { url: pathToFileURL(remote).href, baseSha, raisedSha, headSha };
}

export interface RecheckScore {
  name: string;
  expect: RecheckScenarioSpec["expect"];
  protected: boolean;
  /** Whether the finding was picked for the recheck at all. */
  checked: boolean;
  /** Whether the recheck's verdict, through `fixedByRecheck`, closed it. */
  closed: boolean;
  /** Its verdict's reason, for the report. */
  reason?: string;
  error?: string;
  /** Closed though it still holds: the failure that matters. */
  falseClose: boolean;
  /** Kept open though it was fixed: noise, not harm. */
  missedFix: boolean;
}

export interface RecheckRunOptions {
  harness: Harness;
  model: string;
  timeoutMs: number;
  workRoot: string;
  progress?: (line: string) => void;
}

/** Runs one scenario through the control task's recheck code and scores it. */
export async function runRecheckScenario(
  scenario: RecheckScenario,
  options: RecheckRunOptions,
): Promise<RecheckScore> {
  const root = await mkdtemp(join(options.workRoot, `recheck-${scenario.name}-`));
  const protectedCategory = isProtectedCategory(scenario.finding.rule_category);
  const score = (closed: boolean, extra: Partial<RecheckScore> = {}): RecheckScore => ({
    name: scenario.name,
    expect: scenario.expect,
    protected: protectedCategory,
    checked: true,
    closed,
    falseClose: closed && scenario.expect === "holds",
    missedFix: !closed && scenario.expect === "fixed",
    ...extra,
  });
  try {
    const built = await buildRepo(scenario, root);
    const repo = await cloneAtSha({
      url: built.url,
      dir: join(root, "checkout"),
      headSha: built.headSha,
      otherShas: [built.baseSha, built.raisedSha],
      token: "",
    });
    const { finding } = scenario;
    const record = {
      id: "f1",
      fingerprint: "fp1",
      ruleCategory: finding.rule_category,
      severity: finding.severity,
      path: finding.path,
      line: finding.line,
      startLine: finding.start_line,
      side: "RIGHT" as const,
      title: finding.title,
      body: finding.body,
      raisedAtSha: built.raisedSha,
      status: "open" as const,
      githubCommentId: 1000,
      basePath: undefined,
    };
    const job = await recheckJob({
      repo,
      records: [record],
      skip: new Set(),
      sinceSha: built.raisedSha,
      headSha: built.headSha,
      index: 0,
      log: () => undefined,
    });
    if (job === undefined) return score(false, { checked: false });
    options.progress?.(`recheck ${scenario.name}`);
    const outcome = await runRecheck(
      options.harness,
      { index: 0, prompt: job.prompt },
      {
        cwd: repo.dir,
        model: options.model,
        timeoutMs: options.timeoutMs,
        runId: `recheck-${scenario.name}`,
      },
    );
    if (outcome.verdicts === undefined) {
      return score(false, outcome.error === undefined ? {} : { error: outcome.error });
    }
    const fixes = fixedByRecheck(job, outcome.verdicts, {
      reraised: new Set(),
      open: new Set([record.id]),
    });
    const verdict = outcome.verdicts.find((candidate) => candidate.id === "F1");
    // No verdict for the finding would keep it open and read as a right "holds": it's a broken
    // run, not an answer.
    if (verdict === undefined) return score(false, { error: "the recheck gave no verdict for F1" });
    return score(fixes.length > 0, { reason: verdict.reason });
  } catch (error) {
    return score(false, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs every scenario in turn. */
export async function runRecheckScenarios(
  scenarios: readonly RecheckScenario[],
  options: RecheckRunOptions,
): Promise<RecheckScore[]> {
  const scores: RecheckScore[] = [];
  for (const scenario of scenarios) scores.push(await runRecheckScenario(scenario, options));
  return scores;
}

export interface RecheckTotals {
  scenarios: number;
  /** Fixed ones closed and held ones kept, over all. */
  correct: number;
  falseCloses: number;
  missedFixes: number;
  failed: number;
}

export function recheckTotals(scores: readonly RecheckScore[]): RecheckTotals {
  return {
    scenarios: scores.length,
    correct: scores.filter(
      (score) => !score.falseClose && !score.missedFix && score.error === undefined,
    ).length,
    falseCloses: scores.filter((score) => score.falseClose).length,
    missedFixes: scores.filter((score) => score.missedFix).length,
    failed: scores.filter((score) => score.error !== undefined).length,
  };
}

/** What happened to one scenario, as the report's table says it. */
function resultOf(score: RecheckScore): string {
  if (score.error !== undefined) return `failed: ${score.error.split("\n")[0] ?? ""}`;
  if (score.falseClose) return "**closed, but it still holds**";
  if (score.missedFix) return "kept open, though fixed";
  return score.closed ? "closed" : "kept open";
}

/** The report's section: one row per scenario, and the gate (no false close). */
export function renderRecheckMarkdown(scores: readonly RecheckScore[], model: string): string {
  const totals = recheckTotals(scores);
  const rows = scores.map((score) => {
    const result = resultOf(score);
    return `| ${score.name} | ${score.expect}${score.protected ? " (protected)" : ""} | ${result} |`;
  });
  return [
    `## Recheck of carried findings (${model})`,
    "",
    `${totals.correct} of ${totals.scenarios} right. False closes: ${totals.falseCloses}. Missed fixes: ${totals.missedFixes}.`,
    "",
    "| Scenario | Expected | Result |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
