#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { FileTranscriptStore } from "@lgtmoose/pipeline";
import { loadFixtures, type Fixture } from "./fixture.js";
import {
  matrixAssignments,
  matrixRan,
  modelsFrom,
  renderMatrixMarkdown,
  runMatrix,
  type Assignment,
} from "./matrix.js";
import { EVAL_PROVIDERS } from "./providers.js";
import {
  baselineFrom,
  buildReport,
  checkBaseline,
  readBaseline,
  renderMarkdown,
  type Baseline,
  type EvalReport,
  type GateResult,
} from "./report.js";
import { runFixtures } from "./run.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const HELP = `Usage: lgtmoose-evals [options]

Runs the review pipeline (the one behind \`lgtmoose review --dry-run\`) with Claude Code on every
fixture, scores the findings and writes report.md and report.json. Needs a model credential in
the environment, as the dry run does. Exits 1 when recall falls below the baseline, and 2 when
the evals couldn't run (bad fixtures or options, or every fixture run failed, as without a
model credential).

Options:
  --fixtures <dir>     Another fixture directory, run with this package's fixtures/
                       (repeatable). LGTMOOSE_EVAL_FIXTURES adds more, separated by "${delimiter}".
                       For private fixtures kept outside this repository.
  --no-public          Leave out this package's fixtures/ and run only the extra ones
  --only <name>        Run only this fixture (repeatable); the baseline isn't checked
  --out <dir>          Where to write the report and transcripts (default: ./eval-report)
  --baseline <file>    Baseline to compare with (default: this package's baseline.json)
  --update-baseline    Write this run's numbers to the baseline file instead of gating
  --model <name>       Reviewer model for Claude Code (default: sonnet). In a matrix run,
                       --model <provider>=<name> sets one provider's model (repeatable)
  --timeout <minutes>  Time limit for each batch (default: 15)
  --claude <path>      The claude binary (default: claude on PATH), also for agent-sdk
  --codex <path>       The codex binary (default: codex on PATH)
  --cursor <path>      The Cursor agent binary (default: agent on PATH)
  -h, --help

Provider matrix (instead of the single Claude Code run and its baseline gate):
  --providers <ids>    Run every fixture with the reviewer on each provider in turn, such as
                       claude,chatgpt,cursor. Providers: ${Object.keys(EVAL_PROVIDERS).join(", ")}
  --roles <spec>       One configuration with a provider per role, such as reviewer=claude
                       (repeatable). Only roles the pipeline runs today can be set: reviewer
  --results <dir>      Also keep a timestamped copy of matrix.json here, to compare runs later

A matrix run writes matrix.md (the side-by-side table) and matrix.json to --out, and each
configuration's report.md, report.json and transcripts to a folder of its own. A provider
without a credential is skipped, and limit hits are counted, not fatal. It exits 2 when no
configuration could run, and 0 otherwise.
`;

/**
 * Whether the run passes: updating the baseline always does, and a subset (--only) isn't
 * compared, since its recall isn't comparable with the whole set's baseline.
 */
function gateFor(
  report: EvalReport,
  baseline: Baseline | undefined,
  run: { updating: boolean; subset: boolean; baselinePath: string },
): GateResult {
  if (run.updating) return { ok: true, message: `Baseline updated in ${run.baselinePath}.` };
  if (run.subset) {
    return { ok: true, message: "Ran a subset (--only): not compared with the baseline." };
  }
  return checkBaseline(report, baseline);
}

async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      fixtures: { type: "string", multiple: true },
      "no-public": { type: "boolean" },
      only: { type: "string", multiple: true },
      out: { type: "string" },
      baseline: { type: "string" },
      "update-baseline": { type: "boolean" },
      model: { type: "string", multiple: true },
      timeout: { type: "string" },
      claude: { type: "string" },
      codex: { type: "string" },
      cursor: { type: "string" },
      providers: { type: "string" },
      roles: { type: "string", multiple: true },
      results: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const minutes = Number(values.timeout ?? "15");
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--timeout is minutes per batch.");
  const models = modelsFrom(values.model);
  const out = resolve(values.out ?? "eval-report");
  const matrix = values.providers !== undefined || values.roles !== undefined;
  if (matrix && (values["update-baseline"] || values.baseline !== undefined)) {
    throw new Error(
      "A matrix run (--providers, --roles) isn't compared with a baseline: leave out --baseline and --update-baseline.",
    );
  }
  if (!matrix && values.results !== undefined) {
    throw new Error("--results is for matrix runs: add --providers or --roles.");
  }
  const assignments = matrix
    ? matrixAssignments({ providers: values.providers, roles: values.roles }, EVAL_PROVIDERS)
    : [];
  const binaries: Record<string, string | undefined> = {
    claude: values.claude,
    "agent-sdk": values.claude,
    chatgpt: values.codex,
    cursor: values.cursor,
  };
  const baselinePath = resolve(values.baseline ?? join(PACKAGE_DIR, "baseline.json"));

  if (values["update-baseline"] && values.only !== undefined) {
    throw new Error("--update-baseline needs every fixture: leave out --only.");
  }
  const extra = [
    ...(values.fixtures ?? []),
    ...(process.env.LGTMOOSE_EVAL_FIXTURES ?? "").split(delimiter).filter((dir) => dir !== ""),
  ].map((dir) => resolve(dir));
  const roots = [...(values["no-public"] ? [] : [join(PACKAGE_DIR, "fixtures")]), ...extra];
  if (roots.length === 0) {
    throw new Error("--no-public needs --fixtures or LGTMOOSE_EVAL_FIXTURES.");
  }
  // The committed baseline is measured on the public fixtures; a run with others needs its own.
  if (values["update-baseline"] && extra.length > 0 && values.baseline === undefined) {
    throw new Error(
      "--update-baseline with extra fixtures needs --baseline <file>: the committed baseline is for the public fixtures.",
    );
  }
  let fixtures = await loadFixtures(roots);
  if (values.only !== undefined) {
    const only = new Set(values.only);
    fixtures = fixtures.filter((fixture) => only.has(fixture.name));
    const missing = [...only].filter((name) => !fixtures.some((f) => f.name === name));
    if (missing.length > 0) throw new Error(`No fixture named ${missing.join(", ")}.`);
  }

  await mkdir(out, { recursive: true });
  const workRoot = await mkdtemp(join(tmpdir(), "lgtmoose-evals-"));
  const startedAt = new Date();
  try {
    if (matrix) {
      return await runMatrixMode(fixtures, assignments, {
        out,
        workRoot,
        models,
        binaries,
        batchTimeoutMs: Math.round(minutes * 60_000),
        results: values.results === undefined ? undefined : resolve(values.results),
      });
    }
    const model = models.claude ?? "sonnet";
    const claude = EVAL_PROVIDERS.claude;
    if (claude === undefined) throw new Error("The claude provider is missing.");
    const harness = claude.create({
      transcripts: new FileTranscriptStore(join(out, "transcripts")),
      env: process.env,
      ...(values.claude === undefined ? {} : { binaryPath: values.claude }),
    });
    const scores = await runFixtures(fixtures, {
      harness,
      model,
      batchTimeoutMs: Math.round(minutes * 60_000),
      workRoot,
      progress: (line) => process.stderr.write(`${line}\n`),
    });
    const report = buildReport(scores, model, startedAt);
    const baseline = await readBaseline(baselinePath);
    // A failed run (a timeout, a rate limit, no credential) scores as misses, which would read
    // as a recall drop. Report it as "couldn't run" instead, and never make it the baseline.
    const failed = report.totals.failedRuns;
    const gate =
      failed > 0
        ? {
            ok: false,
            message:
              failed === report.fixtures.length
                ? "Every fixture run failed, so there's nothing to score."
                : `${failed} of ${report.fixtures.length} fixture runs failed, so recall wasn't compared with the baseline. Rerun once they pass.`,
          }
        : gateFor(report, baseline, {
            updating: values["update-baseline"] === true,
            subset: values.only !== undefined,
            baselinePath,
          });
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(out, "report.md"), renderMarkdown(report, baseline, gate));
    process.stderr.write(`${gate.message}\nReport: ${join(out, "report.md")}\n`);
    if (failed > 0) return 2;
    if (values["update-baseline"]) {
      await writeFile(baselinePath, `${JSON.stringify(baselineFrom(report), null, 2)}\n`);
    }
    return gate.ok ? 0 : 1;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

/** A configuration's folder name under --out. */
function folderOf(assignment: Assignment): string {
  return assignment.label.replace(/[^A-Za-z0-9-]+/g, "_");
}

/** Runs the fixtures on each configuration and writes the table, the results and the reports. */
async function runMatrixMode(
  fixtures: readonly Fixture[],
  assignments: readonly Assignment[],
  run: {
    out: string;
    workRoot: string;
    models: Record<string, string>;
    binaries: Record<string, string | undefined>;
    batchTimeoutMs: number;
    results: string | undefined;
  },
): Promise<number> {
  const results = await runMatrix(fixtures, assignments, {
    providers: EVAL_PROVIDERS,
    env: process.env,
    harnessFor: (provider, assignment) => {
      const binaryPath = run.binaries[provider.id];
      return provider.create({
        transcripts: new FileTranscriptStore(join(run.out, folderOf(assignment), "transcripts")),
        env: process.env,
        ...(binaryPath === undefined ? {} : { binaryPath }),
      });
    },
    models: run.models,
    batchTimeoutMs: run.batchTimeoutMs,
    workRoot: run.workRoot,
    progress: (line) => process.stderr.write(`${line}\n`),
    onReport: async (assignment, report) => {
      const dir = join(run.out, folderOf(assignment));
      await mkdir(dir, { recursive: true });
      const gate = { ok: true, message: `Configuration ${assignment.label}.` };
      await writeFile(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(join(dir, "report.md"), renderMarkdown(report, undefined, gate));
    },
  });
  const json = `${JSON.stringify(results, null, 2)}\n`;
  await writeFile(join(run.out, "matrix.json"), json);
  await writeFile(join(run.out, "matrix.md"), renderMatrixMarkdown(results));
  if (run.results !== undefined) {
    await mkdir(run.results, { recursive: true });
    const stamp = results.startedAt.replace(/[:.]/g, "-");
    await writeFile(join(run.results, `matrix-${stamp}.json`), json);
  }
  const ran = matrixRan(results);
  process.stderr.write(
    `${ran ? "Matrix done." : "No configuration could run."}\nReport: ${join(run.out, "matrix.md")}\n`,
  );
  return ran ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
