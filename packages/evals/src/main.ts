#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeCodeHarness } from "@lgtmoose/harness";
import { FileTranscriptStore } from "@lgtmoose/pipeline";
import { loadFixtures } from "./fixture.js";
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
  --fixtures <dir>     Fixture directory (default: this package's fixtures/)
  --only <name>        Run only this fixture (repeatable); the baseline isn't checked
  --out <dir>          Where to write the report and transcripts (default: ./eval-report)
  --baseline <file>    Baseline to compare with (default: this package's baseline.json)
  --update-baseline    Write this run's numbers to the baseline file instead of gating
  --model <name>       Reviewer model (default: sonnet)
  --timeout <minutes>  Time limit for each batch (default: 15)
  --claude <path>      The claude binary (default: claude on PATH)
  -h, --help
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
      fixtures: { type: "string" },
      only: { type: "string", multiple: true },
      out: { type: "string" },
      baseline: { type: "string" },
      "update-baseline": { type: "boolean" },
      model: { type: "string" },
      timeout: { type: "string" },
      claude: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const minutes = Number(values.timeout ?? "15");
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("--timeout is minutes per batch.");
  const model = values.model ?? "sonnet";
  const out = resolve(values.out ?? "eval-report");
  const baselinePath = resolve(values.baseline ?? join(PACKAGE_DIR, "baseline.json"));

  if (values["update-baseline"] && values.only !== undefined) {
    throw new Error("--update-baseline needs every fixture: leave out --only.");
  }
  let fixtures = await loadFixtures(resolve(values.fixtures ?? join(PACKAGE_DIR, "fixtures")));
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
    const harness = new ClaudeCodeHarness({
      transcripts: new FileTranscriptStore(join(out, "transcripts")),
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
    const gate = gateFor(report, baseline, {
      updating: values["update-baseline"] === true,
      subset: values.only !== undefined,
      baselinePath,
    });
    await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(out, "report.md"), renderMarkdown(report, baseline, gate));
    if (values["update-baseline"]) {
      await writeFile(baselinePath, `${JSON.stringify(baselineFrom(report), null, 2)}\n`);
    }
    process.stderr.write(`${gate.message}\nReport: ${join(out, "report.md")}\n`);
    // Nothing ran (no credential, the CLI missing): the scores mean nothing, whatever the gate.
    if (report.fixtures.length > 0 && report.totals.failedRuns === report.fixtures.length) {
      process.stderr.write("Every fixture run failed; see the report's details.\n");
      return 2;
    }
    return gate.ok ? 0 : 1;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
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
