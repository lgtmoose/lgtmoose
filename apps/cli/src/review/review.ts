import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ConfigError } from "@lgtmoose/config";
import { GitHubRequestError } from "../github-request.js";
import { formatJson, formatText, terminalSafe } from "./output.js";
import { runReview, type ReviewDeps } from "@lgtmoose/pipeline";
import { parseTarget, type PullTarget } from "./target.js";
import { errorMessage } from "../errors.js";

export const REVIEW_HELP = `Usage: lgtmoose review <owner/repo#123 | PR URL> --dry-run [options]

Reviews one pull request on this machine and prints what LGTMoose would post: the findings,
the decision and the summary comment. Nothing is posted to GitHub.

It reads the PR with GITHUB_TOKEN, GH_TOKEN or \`gh auth token\`, clones it into a temporary
directory, and runs Claude Code here with a model credential from the environment:
CLAUDE_CODE_OAUTH_TOKEN (from \`claude setup-token\`), ANTHROPIC_API_KEY, or Bedrock or Vertex
settings. A \`claude login\` session isn't used: each run gets a fresh, empty Claude home.

Options:
  --dry-run             Required for now: posting reviews comes with the review workflow
  --json                Print the result as JSON, for scripts
  --model <name>        Reviewer model, passed to Claude Code (default: sonnet)
  --timeout <minutes>   Time limit for each batch (default: 15)
  --transcripts <dir>   Where to save run transcripts (default: a new temporary directory)
  --claude <path>       The claude binary (default: claude on PATH)
  -h, --help

Exit codes: 0 when the review is complete, 2 when it isn't (a batch failed, or new code or a
lockfile change was skipped and needs a person), 1 on errors.

Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1 so the GitHub API calls use HTTPS_PROXY too
(git and Claude Code already do).
`;

/** What the command needs to build its I/O: the parsed flags. */
export interface ReviewCommandFlags {
  target: PullTarget;
  json: boolean;
  model: string;
  timeoutMs: number;
  transcripts: string | undefined;
  claude: string | undefined;
}

/** The dry run's I/O, built once the flags are known. */
export interface ReviewEnvironment {
  deps: ReviewDeps;
  /** Where transcripts are saved, for the output. */
  transcriptDir: string;
}

export type ReviewEnvironmentFactory = (flags: ReviewCommandFlags) => Promise<ReviewEnvironment>;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class UsageError extends Error {}

const DEFAULT_MODEL = "sonnet";
const DEFAULT_TIMEOUT_MINUTES = 15;

function parseFlags(argv: readonly string[]): ReviewCommandFlags | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        model: { type: "string" },
        timeout: { type: "string" },
        transcripts: { type: "string" },
        claude: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals.length !== 1) {
    throw new UsageError("Give one pull request, like owner/repo#123 or its URL.");
  }
  const target = parseTarget(positionals[0] ?? "");
  if (target === undefined) {
    throw new UsageError(
      `"${positionals[0]}" isn't a pull request. Use owner/repo#123 or its URL.`,
    );
  }
  if (!values["dry-run"]) {
    throw new UsageError(
      "Posting reviews isn't built yet. Pass --dry-run to see what would be posted.",
    );
  }
  const minutes = values.timeout === undefined ? DEFAULT_TIMEOUT_MINUTES : Number(values.timeout);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) {
    throw new UsageError("--timeout is minutes per batch, from 1 to 120.");
  }
  const model = values.model ?? DEFAULT_MODEL;
  if (!/^[\w.:@/[\]-]+$/.test(model)) throw new UsageError(`"${model}" isn't a model name.`);
  return {
    target,
    json: values.json === true,
    model,
    timeoutMs: Math.round(minutes * 60_000),
    transcripts: values.transcripts,
    claude: values.claude,
  };
}

/** Why the run stopped, in words that don't leak a token. */
function failureText(error: unknown): string {
  if (error instanceof GitHubRequestError) {
    const hint =
      error.status === 401 || error.status === 404
        ? " Check that the token can read this repository."
        : "";
    return `${error.message}${hint}`;
  }
  if (error instanceof ConfigError) return error.message;
  return errorMessage(error);
}

/** `lgtmoose review`: a dry run of the whole review for one PR. */
export async function runReviewCommand(
  argv: readonly string[],
  environment: ReviewEnvironmentFactory,
): Promise<CommandResult> {
  let flags: ReviewCommandFlags | "help";
  try {
    flags = parseFlags(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      return { exitCode: 1, stdout: "", stderr: `${error.message}\n\n${REVIEW_HELP}` };
    }
    throw error;
  }
  if (flags === "help") return { exitCode: 0, stdout: REVIEW_HELP, stderr: "" };

  try {
    const { deps, transcriptDir } = await environment(flags);
    const report = await runReview(deps, {
      target: flags.target,
      model: flags.model,
      batchTimeoutMs: flags.timeoutMs,
      runId: randomUUID(),
    });
    return {
      exitCode: report.complete ? 0 : 2,
      stdout: flags.json ? formatJson(report, transcriptDir) : formatText(report, transcriptDir),
      stderr: "",
    };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${terminalSafe(failureText(error))}\n` };
  }
}
