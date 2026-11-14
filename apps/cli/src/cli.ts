import { parseArgs } from "node:util";
import type { AuthDeps } from "./auth/auth.js";
import type { DeployDeps } from "./deploy/deploy.js";
import type { ReviewEnvironmentFactory } from "./review/review.js";
import type { SetupDeps } from "./setup/setup.js";

export const VERSION = "0.0.0";

/** Commands planned for M1–M3. Each one is a stub until its ticket lands. */
export const COMMANDS = {
  setup: "Create the GitHub App and write lgtmoose.config.ts",
  auth: "Store a model provider's credential: claude, codex, cursor, bedrock, api-key, list, remove",
  deploy: "Deploy every CDK stack and point the App's webhook at it",
  destroy: "Remove the stacks; keeps the database snapshot and bucket unless --purge",
  review: "Review one PR on this machine and print the result: review owner/repo#123 --dry-run",
} as const;

export type Command = keyof typeof COMMANDS;

export function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, summary]) => `  ${name.padEnd(width)}  ${summary}`,
  );
  return ["Usage: lgtmoose <command> [options]", "", "Commands:", ...lines, ""].join("\n");
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Builds setup's I/O. Tests pass fakes; by default it's AWS, GitHub and a real terminal. */
  setupDeps?: () => Promise<SetupDeps>;
  /** Builds auth's I/O, the same way. */
  authDeps?: () => Promise<AuthDeps>;
  /** Builds deploy and destroy's I/O, the same way. */
  deployDeps?: () => Promise<DeployDeps>;
  /** Builds the review dry run's I/O from its flags: GitHub, git and Claude Code by default. */
  reviewEnvironment?: ReviewEnvironmentFactory;
}

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  // Commands own their flags, so hand them everything after the command name. Imported lazily
  // so `--help` doesn't load the AWS SDK.
  if (argv[0] === "setup") {
    const { runSetup } = await import("./setup/setup.js");
    const getDeps =
      options.setupDeps ?? (async () => (await import("./setup/deps.js")).defaultSetupDeps());
    return runSetup(argv.slice(1), getDeps);
  }
  if (argv[0] === "auth") {
    const { runAuth } = await import("./auth/auth.js");
    const getDeps =
      options.authDeps ?? (async () => (await import("./auth/deps.js")).defaultAuthDeps());
    return runAuth(argv.slice(1), getDeps);
  }
  if (argv[0] === "deploy" || argv[0] === "destroy") {
    const { runDeploy, runDestroy } = await import("./deploy/deploy.js");
    const getDeps =
      options.deployDeps ?? (async () => (await import("./deploy/deps.js")).defaultDeployDeps());
    return (argv[0] === "deploy" ? runDeploy : runDestroy)(argv.slice(1), getDeps);
  }

  if (argv[0] === "review") {
    const { runReviewCommand } = await import("./review/review.js");
    const environment: ReviewEnvironmentFactory =
      options.reviewEnvironment ??
      (async (flags) => (await import("./review/deps.js")).defaultReviewEnvironment(flags));
    return runReviewCommand(argv.slice(1), environment);
  }

  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    return { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  }

  const [command] = positionals;
  if (values.help || command === undefined) {
    return { exitCode: 0, stdout: helpText(), stderr: "" };
  }

  if (!(command in COMMANDS)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Unknown command "${command}".\n\n${helpText()}`,
    };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `"${command}" isn't built yet. ${COMMANDS[command as Command]}\n`,
  };
}
