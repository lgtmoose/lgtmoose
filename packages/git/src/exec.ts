import { execFile } from "node:child_process";

/** A git command failed. The message never contains a token: see `redact`. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunOptions {
  /** Extra `-c key=value` settings for this command only, never written to disk. */
  config?: Readonly<Record<string, string>>;
  /** Strings to hide from errors (tokens, auth headers). */
  secrets?: readonly string[];
  /** Exit codes that aren't failures, e.g. 1 for `merge-base --is-ancestor`. */
  okExitCodes?: readonly number[];
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

const MAX_OUTPUT = 512 * 1024 * 1024;

function redact(text: string, secrets: readonly string[] = []): string {
  return secrets.reduce((out, secret) => (secret ? out.split(secret).join("***") : out), text);
}

/**
 * Runs git in `cwd`. Never prompts for credentials, never reads system or global config (so a
 * machine's settings can't change a review), and treats output as UTF-8.
 */
export function runGit(cwd: string, args: readonly string[], options: RunOptions = {}) {
  const config = Object.entries(options.config ?? {}).flatMap(([key, value]) => [
    "-c",
    `${key}=${value}`,
  ]);
  const fullArgs = [...config, ...args];
  return new Promise<RunResult>((resolve, reject) => {
    execFile(
      "git",
      fullArgs,
      {
        cwd,
        maxBuffer: MAX_OUTPUT,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        // A failure without a numeric code (git not found, output too large) has no exit code.
        let exitCode: number | undefined = 0;
        if (error) exitCode = typeof error.code === "number" ? error.code : undefined;
        if (exitCode !== undefined && (exitCode === 0 || options.okExitCodes?.includes(exitCode))) {
          resolve({ stdout, exitCode });
          return;
        }
        const command = redact(`git ${args.join(" ")}`, options.secrets);
        const detail = redact(stderr.trim() || (error?.message ?? ""), options.secrets);
        reject(
          new GitError(`${command} failed: ${detail}`, exitCode, redact(stderr, options.secrets)),
        );
      },
    );
  });
}
