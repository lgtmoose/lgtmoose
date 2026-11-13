import { execFile } from "node:child_process";
import { devNull } from "node:os";

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
  /** Exit codes that aren't failures, e.g. 1 for `cat-file -e` on a missing object. */
  okExitCodes?: readonly number[];
  /** Written to the command's stdin. */
  input?: string;
  /** Extra environment variables. */
  env?: Readonly<Record<string, string>>;
}

export interface RunResult<T> {
  stdout: T;
  exitCode: number;
}

const MAX_OUTPUT = 512 * 1024 * 1024;

function redact(text: string, secrets: readonly string[] = []): string {
  return secrets.reduce((out, secret) => (secret ? out.split(secret).join("***") : out), text);
}

function run(
  cwd: string,
  args: readonly string[],
  options: RunOptions,
  encoding: "utf8" | "buffer",
): Promise<RunResult<string | Buffer>> {
  const config = Object.entries(options.config ?? {}).flatMap(([key, value]) => [
    "-c",
    `${key}=${value}`,
  ]);
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...config, ...args],
      {
        cwd,
        maxBuffer: MAX_OUTPUT,
        encoding,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          // A machine's own settings mustn't change a review.
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: devNull,
          LC_ALL: "C",
          ...options.env,
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
        const errText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
        const command = redact(`git ${args.join(" ")}`, options.secrets);
        const detail = redact(errText.trim() || (error?.message ?? ""), options.secrets);
        reject(
          new GitError(`${command} failed: ${detail}`, exitCode, redact(errText, options.secrets)),
        );
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Runs git in `cwd` and returns its output as UTF-8. Never prompts for credentials. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult<string>> {
  return (await run(cwd, args, options, "utf8")) as RunResult<string>;
}

/** Like runGit, but returns raw bytes, for output that mixes headers and binary content. */
export async function runGitBytes(
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult<Buffer>> {
  return (await run(cwd, args, options, "buffer")) as RunResult<Buffer>;
}
