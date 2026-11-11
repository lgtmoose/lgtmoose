import { parseArgs } from "node:util";

export const VERSION = "0.0.0";

/** Commands planned for M1–M3. Each one is a stub until its ticket lands. */
export const COMMANDS = {
  setup: "Create the GitHub App and write lgtmoose.config.ts (NIC-802)",
  auth: "Connect a model provider: claude, codex, cursor, bedrock, api-key (NIC-824)",
  deploy: "Deploy every CDK stack and point the App's webhook at it (NIC-803)",
  destroy: "Remove the stacks; keeps data unless --purge (NIC-803)",
  review: "Review one PR locally, e.g. review owner/repo#123 --dry-run (NIC-809)",
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

export function run(argv: readonly string[]): RunResult {
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
