import { spawn } from "node:child_process";

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The child's whole environment. Nothing is inherited from this process. */
  env: Readonly<Record<string, string>>;
  /** Written to stdin, which is then closed. */
  input: string;
  /** Kill the process tree after this long. */
  timeoutMs: number;
  /** Time between SIGTERM and SIGKILL. */
  killGraceMs: number;
  /** Stop and kill the tree once stdout passes this many bytes. */
  maxOutputBytes: number;
  /** Called for each complete stdout line. Returning "kill" stops the run early. */
  onLine?: (line: string) => "kill" | undefined;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Why this side stopped the process, if it did. */
  stopped?: "timeout" | "output_limit" | "requested";
  /** Set when the process couldn't be started. */
  spawnError?: Error;
}

const MAX_STDERR = 64 * 1024;

/**
 * Sends a signal to the child's whole process group. The child is started detached, so it leads
 * its own group and this reaches every process it started too.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs a command in its own process group. On timeout it sends SIGTERM to the group, then
 * SIGKILL after a grace period. After a normal exit it kills the group too, so nothing the
 * command started outlives it.
 */
export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: ProcessResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let pending = "";
    let stderr = "";
    let stopped: ProcessResult["stopped"];
    let spawnError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stop = (reason: NonNullable<ProcessResult["stopped"]>): void => {
      if (stopped || child.pid === undefined) return;
      stopped = reason;
      const pid = child.pid;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), options.killGraceMs);
    };

    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxOutputBytes) {
        stop("output_limit");
        return;
      }
      stdoutChunks.push(chunk);
      if (!options.onLine) return;
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (options.onLine(line) === "kill") stop("requested");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8").slice(0, MAX_STDERR);
    });
    // The child may exit before reading its input.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      spawnError = error;
      // Without a pid it never started, and "close" may not follow.
      if (child.pid === undefined) {
        finish({ stdout: "", stderr, exitCode: null, signal: null, spawnError: error });
      }
    });
    child.on("exit", () => {
      // Anything the command left running goes with it.
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
    });
    child.on("close", (exitCode, signal) => {
      const result: ProcessResult = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
        exitCode,
        signal,
      };
      if (stopped) result.stopped = stopped;
      if (spawnError) result.spawnError = spawnError;
      finish(result);
    });

    child.stdin.end(options.input);
  });
}
