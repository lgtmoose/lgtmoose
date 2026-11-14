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

/**
 * stderr kept: its start (what the CLI said first) and its end (where its final error is), so
 * chatty output in between can't push the cause out.
 */
const STDERR_HEAD = 16 * 1024;
const STDERR_TAIL = 48 * 1024;

/** Collects a stream's text, keeping its first and last characters (`STDERR_HEAD`, `_TAIL`). */
export class HeadTail {
  private head = "";
  private tail = "";
  private dropped = 0;

  constructor(
    private readonly headSize = STDERR_HEAD,
    private readonly tailSize = STDERR_TAIL,
  ) {}

  add(text: string): void {
    let rest = text;
    if (this.head.length < this.headSize) {
      const room = this.headSize - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest === "") return;
    this.tail += rest;
    // Trimmed in batches, so collecting stays linear.
    if (this.tail.length > 2 * this.tailSize) this.trim();
  }

  text(): string {
    this.trim();
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n… ${this.dropped} characters left out …\n${this.tail}`;
  }

  /** A text cut down the same way: its start and end, with what's left out noted between. */
  static of(text: string): string {
    const kept = new HeadTail();
    kept.add(text);
    return kept.text();
  }

  private trim(): void {
    if (this.tail.length <= this.tailSize) return;
    this.dropped += this.tail.length - this.tailSize;
    this.tail = this.tail.slice(-this.tailSize);
  }
}

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
    const stderr = new HeadTail();
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
    // Decoded as a stream, so a character split across chunks stays whole.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.add(chunk));
    // The child may exit before reading its input.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      spawnError = error;
      // Without a pid it never started, and "close" may not follow.
      if (child.pid === undefined) {
        finish({
          stdout: "",
          stderr: stderr.text(),
          exitCode: null,
          signal: null,
          spawnError: error,
        });
      }
    });
    child.on("exit", () => {
      // Anything the command left running goes with it.
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
    });
    child.on("close", (exitCode, signal) => {
      const result: ProcessResult = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderr.text(),
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
