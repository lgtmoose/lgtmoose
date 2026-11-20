import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { cloneAtSha } from "@lgtmoose/git";
import type { Harness } from "@lgtmoose/harness";
import { runReview, type PullReader } from "@lgtmoose/pipeline";
import { buildFixtureRepo, type Fixture } from "./fixture.js";
import { findingHitRates, scoreFixture, type FixtureScore } from "./score.js";

export interface RunOptions {
  harness: Harness;
  /** The reviewer model, passed to the harness as is. */
  model: string;
  /** Deadline for each batch's run. */
  batchTimeoutMs: number;
  /** A directory for the fixtures' repositories and checkouts. Removed per fixture after use. */
  workRoot: string;
  /** Progress lines, such as which fixture is running. */
  progress?: (line: string) => void;
  /** Clock, for tests. */
  now?: () => number;
  /** Cap on the reviewer's thinking tokens. Unset keeps the model's own thinking. */
  thinkingTokens?: number;
  /**
   * How many times to run each fixture. The returned score is the first run, so a baseline still
   * compares one run. Further runs only fill `hitRates`.
   */
  repeat?: number;
}

/** A PR reader that serves the fixture as the PR, with no comments on it. */
function fixturePull(fixture: Fixture, headSha: string, baseSha: string): PullReader {
  return {
    pull: async () => ({
      title: fixture.title,
      body: fixture.body,
      author: "evals",
      headSha,
      headRef: "pr",
      baseSha,
      baseRef: "main",
      state: "open",
    }),
    comments: async () => [],
  };
}

/**
 * Runs the real review pipeline (the one behind `lgtmoose review --dry-run`) on one fixture and
 * scores what it would post. A run that fails outright is scored as finding nothing, with the
 * error recorded.
 */
export async function runFixture(
  fixture: Fixture,
  options: RunOptions,
  runNumber = 1,
): Promise<FixtureScore> {
  const now = options.now ?? Date.now;
  const root = await mkdtemp(join(options.workRoot, `${fixture.name}-`));
  const started = now();
  try {
    const repo = await buildFixtureRepo(fixture, join(root, "repo"));
    const repeat = options.repeat ?? 1;
    const which = repeat > 1 ? ` (run ${runNumber} of ${repeat})` : "";
    options.progress?.(`Reviewing fixture ${fixture.name}${which}…`);
    const report = await runReview(
      {
        github: fixturePull(fixture, repo.headSha, repo.baseSha),
        clone: cloneAtSha,
        cloneUrl: () => repo.url,
        token: "",
        harness: options.harness,
        workDir: async () => {
          const dir = await mkdtemp(join(root, "checkout-"));
          return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
        },
        progress: (line) => options.progress?.(`  ${line}`),
      },
      {
        target: { owner: "evals", repo: fixture.name, number: 1 },
        model: options.model,
        batchTimeoutMs: options.batchTimeoutMs,
        runId: repeat > 1 ? `evals-${fixture.name}-run-${runNumber}` : `evals-${fixture.name}`,
        ...(options.thinkingTokens === undefined ? {} : { thinkingTokens: options.thinkingTokens }),
      },
    );
    const costUsd = report.batches.reduce((sum, batch) => sum + (batch.usage?.costUsd ?? 0), 0);
    const errors = report.batches.flatMap((batch) =>
      batch.error === undefined ? [] : [`batch ${batch.index + 1}: ${batch.error}`],
    );
    return scoreFixture(fixture, {
      findings: [...report.inline, ...report.body],
      costUsd,
      durationMs: now() - started,
      errors,
    });
  } catch (error) {
    return scoreFixture(fixture, {
      findings: [],
      costUsd: 0,
      durationMs: now() - started,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs every fixture, one after another (they share the model's rate limit). */
export async function runFixtures(
  fixtures: readonly Fixture[],
  options: RunOptions,
): Promise<FixtureScore[]> {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("repeat is how many times to run each fixture, at least 1.");
  }
  const scores: FixtureScore[] = [];
  for (const fixture of fixtures) {
    const runs: FixtureScore[] = [];
    for (let runNumber = 1; runNumber <= repeat; runNumber += 1) {
      runs.push(await runFixture(fixture, options, runNumber));
    }
    const first = runs[0];
    if (first === undefined) continue;
    const hitRates = findingHitRates(runs);
    scores.push(hitRates.length === 0 ? first : { ...first, hitRates });
  }
  return scores;
}
