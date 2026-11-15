import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { STACK_NAMES, STACK_OUTPUTS, type DeployConfig } from "@lgtmoose/config";
import {
  feedbackReportSchema,
  type CategoryReport,
  type DeclinedFinding,
  type FeedbackReport,
} from "@lgtmoose/core";
import type { StackLookup } from "../deploy/aws-cloudformation.js";
import { errorMessage } from "../errors.js";
import { CLI } from "../paths.js";

export const FEEDBACK_HELP = `Usage: ${CLI} feedback <report | export-declined> [options]

How often people accept LGTMoose's findings, per rule category: from findings fixed, declined
or disputed, and 👍/👎 on its inline comments. The reconciler works this out on its schedule and
keeps the latest report in the deployment's artifact bucket; this command reads it with your
AWS credentials. These are signals only: nothing changes on its own.

  report            Print acceptance per category. Categories below the threshold are flagged
                    for you to look at; protected ones (authz, money, secrets…) are never
                    demoted, only flagged.
  export-declined   Write "must not flag" eval fixture skeletons for declined findings, with
                    the code from GitHub (GITHUB_TOKEN, GH_TOKEN or \`gh auth token\`).

Options:
  --json             report: print the report as JSON
  --out <dir>        export-declined: where to write the fixtures (required)
  --repo <owner/name>  export-declined: only this repository's findings
  --limit <n>        export-declined: at most this many (default: 20)
  -h, --help
`;

export interface FeedbackDeps {
  loadConfig(): Promise<DeployConfig | undefined>;
  stacks(region: string): StackLookup;
  /** The object's text, or undefined when there's none. */
  readObject(region: string, bucket: string, key: string): Promise<string | undefined>;
  /** A GitHub token, or undefined when there's none. */
  githubToken(): Promise<string | undefined>;
  /** The file's text at `ref`, or undefined when it doesn't exist there. */
  fileAt(token: string, repo: string, path: string, ref: string): Promise<string | undefined>;
  writeFile(path: string, text: string): Promise<void>;
  reportKey: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class UsageError extends Error {}

const fail = (message: string, exitCode = 1): CommandResult => ({
  exitCode,
  stdout: "",
  stderr: `${message}\n`,
});

/** A path inside a repository, safe to join under a fixture directory. */
function safeRepoPath(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === "." || part === "")
  );
}

async function loadReport(deps: FeedbackDeps): Promise<FeedbackReport> {
  const config = await deps.loadConfig();
  if (config === undefined) throw new UsageError(`No config found. Run ${CLI} setup first.`);
  const data = await deps.stacks(config.region).describe(STACK_NAMES.data);
  const bucket = data?.outputs[STACK_OUTPUTS.data.artifactBucketName];
  if (bucket === undefined) {
    throw new UsageError(
      `No deployed ${STACK_NAMES.data} stack in ${config.region}. Run ${CLI} deploy first.`,
    );
  }
  const text = await deps.readObject(config.region, bucket, deps.reportKey);
  if (text === undefined) {
    throw new UsageError(
      "No feedback report yet: the reconciler writes one on its next scheduled run.",
    );
  }
  return feedbackReportSchema.parse(JSON.parse(text));
}

const percent = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);

function flagText(category: CategoryReport): string {
  if (!category.flagged) return "";
  return category.protected ? "flagged (protected)" : "flagged";
}

/** The report as a plain table, flagged categories first. */
export function formatReport(report: FeedbackReport): string {
  const header = [
    "category",
    "findings",
    "fixed",
    "declined",
    "disputed",
    "👍",
    "👎",
    "accepted",
    "",
  ];
  const row = (c: CategoryReport) => [
    c.category,
    String(c.findings),
    String(c.fixed),
    String(c.declined),
    String(c.disputed),
    String(c.thumbsUp),
    String(c.thumbsDown),
    percent(c.acceptance),
    flagText(c),
  ];
  const rows = [header, ...report.categories.map(row)];
  const widths = header.map((_, i) => Math.max(...rows.map((cells) => (cells[i] ?? "").length)));
  const lines = rows.map((cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  );
  const flagged = report.categories.filter((c) => c.flagged);
  return [
    `Feedback from the last ${report.windowDays} days (report of ${report.generatedAt}).`,
    `A category is flagged below ${percent(report.threshold)} accepted, with at least ${report.minSamples} fixed, declined, disputed or 👍/👎 findings.`,
    "",
    ...(report.categories.length === 0 ? ["No findings yet."] : lines),
    "",
    ...(flagged.length === 0
      ? ["Nothing is flagged."]
      : [
          `${flagged.length} flagged: look at their rules and findings. Nothing is demoted automatically.`,
          ...flagged.flatMap((c) => (c.note === undefined ? [] : [`  ${c.category}: ${c.note}`])),
        ]),
    "",
  ].join("\n");
}

/** A short, stable directory name for one declined finding. */
function fixtureName(finding: DeclinedFinding): string {
  const slug = finding.repo.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const hash = createHash("sha256")
    .update(
      `${finding.repo}#${finding.prNumber}:${finding.path}:${finding.line}:${finding.raisedAtSha}`,
    )
    .digest("hex")
    .slice(0, 8);
  return `declined-${slug}-${finding.prNumber}-${hash}`;
}

/** fixture.json for a declined finding: a clean change the reviewer must not flag there. */
export function declinedFixtureSpec(finding: DeclinedFinding): object {
  return {
    title: `Declined: ${finding.title}`.slice(0, 200),
    body: `Exported from ${finding.repo}#${finding.prNumber}, where a person declined this ${finding.category} finding. Check the files and tighten the lines before adding it to the fixture set.`,
    kind: "clean",
    mustNotFlag: [
      {
        path: finding.path,
        lines: [finding.startLine ?? finding.line, finding.line],
        categories: [finding.category],
        note: `declined in ${finding.repo}#${finding.prNumber}`,
      },
    ],
  };
}

async function exportDeclined(
  deps: FeedbackDeps,
  options: { out: string; repo: string | undefined; limit: number },
): Promise<CommandResult> {
  const report = await loadReport(deps);
  const wanted = report.declined.filter(
    (finding) =>
      options.repo === undefined || finding.repo.toLowerCase() === options.repo.toLowerCase(),
  );
  if (wanted.length === 0)
    return { exitCode: 0, stdout: "No declined findings to export.\n", stderr: "" };
  const token = await deps.githubToken();
  if (token === undefined) {
    return fail("Set GITHUB_TOKEN or GH_TOKEN, or log in with `gh auth login`, to read the code.");
  }
  const written: string[] = [];
  const skipped: string[] = [];
  for (const finding of wanted.slice(0, options.limit)) {
    const where = `${finding.repo}#${finding.prNumber} ${finding.path}:${finding.line}`;
    // A removed line's file at the commit the finding was raised on isn't the base it was in.
    if (finding.side !== "RIGHT" || !safeRepoPath(finding.path)) {
      skipped.push(`${where} (${finding.side === "RIGHT" ? "unsafe path" : "on a removed line"})`);
      continue;
    }
    try {
      const head = await deps.fileAt(token, finding.repo, finding.path, finding.raisedAtSha);
      if (head === undefined) {
        skipped.push(`${where} (the file isn't at ${finding.raisedAtSha.slice(0, 7)} any more)`);
        continue;
      }
      const base = await deps.fileAt(token, finding.repo, finding.path, finding.baseSha);
      const dir = join(options.out, fixtureName(finding));
      await deps.writeFile(
        join(dir, "fixture.json"),
        `${JSON.stringify(declinedFixtureSpec(finding), null, 2)}\n`,
      );
      await deps.writeFile(join(dir, "head", finding.path), head);
      // An added file has no base; base/ still has to exist.
      await deps.writeFile(
        base === undefined ? join(dir, "base", ".keep") : join(dir, "base", finding.path),
        base ?? "",
      );
      written.push(dir);
    } catch (error) {
      skipped.push(`${where} (${errorMessage(error)})`);
    }
  }
  return {
    exitCode: written.length === 0 ? 1 : 0,
    stdout: [
      `Wrote ${written.length} fixture skeleton${written.length === 1 ? "" : "s"}:`,
      ...written.map((dir) => `  ${dir}`),
      ...(skipped.length === 0 ? [] : ["Skipped:", ...skipped.map((line) => `  ${line}`)]),
      "",
      "They hold your repository's code. Review each one, and only add it to a shared fixture set",
      "if the code may be published there.",
      "",
    ].join("\n"),
    stderr: "",
  };
}

export async function runFeedback(
  argv: readonly string[],
  getDeps: () => Promise<FeedbackDeps>,
): Promise<CommandResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        out: { type: "string" },
        repo: { type: "string" },
        limit: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(`${errorMessage(error)}\n\n${FEEDBACK_HELP}`);
  }
  const { values, positionals } = parsed;
  const [sub, ...rest] = positionals;
  if (values.help === true || sub === undefined) {
    return { exitCode: 0, stdout: FEEDBACK_HELP, stderr: "" };
  }
  if (rest.length > 0 || (sub !== "report" && sub !== "export-declined")) {
    return fail(`Unknown feedback command: ${positionals.join(" ")}\n\n${FEEDBACK_HELP}`);
  }
  try {
    if (sub === "report") {
      const report = await loadReport(await getDeps());
      return {
        exitCode: 0,
        stdout:
          values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
        stderr: "",
      };
    }
    if (values.out === undefined || values.out.trim() === "") {
      return fail(`export-declined needs --out <dir>.\n\n${FEEDBACK_HELP}`);
    }
    const limit = Number(values.limit ?? "20");
    if (!Number.isSafeInteger(limit) || limit < 1)
      return fail("--limit is a whole number, at least 1.");
    if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
      return fail("--repo is owner/name.");
    }
    return await exportDeclined(await getDeps(), { out: values.out, repo: values.repo, limit });
  } catch (error) {
    if (error instanceof UsageError) return fail(error.message);
    return fail(`${CLI} feedback ${sub} failed: ${errorMessage(error)}`);
  }
}
