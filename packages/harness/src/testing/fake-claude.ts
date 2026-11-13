import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake `claude` does on one invocation. */
export interface FakeResponse {
  /** Stream-json events written to stdout, one per line. */
  lines?: readonly unknown[];
  /** Raw text written to stdout after the lines. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Start a child that runs until killed. Its pid goes in `grandchild.pid`. */
  grandchild?: boolean;
  /** Ignore SIGTERM and never exit. Its pid goes in `child.pid`. */
  hang?: boolean;
}

export interface FakeCall {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  cwd: string;
}

/**
 * A stand-in `claude` binary: a Node script that records how it was called and replies with
 * canned output. Invocation n gets `responses[n]`, or the last one once they run out.
 */
export class FakeClaude {
  private constructor(
    readonly dir: string,
    readonly binaryPath: string,
  ) {}

  static async create(responses: readonly FakeResponse[]): Promise<FakeClaude> {
    const dir = await mkdtemp(join(tmpdir(), "lgtmoose-fake-claude-"));
    const binaryPath = join(dir, "claude");
    const script = `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const dir = ${JSON.stringify(dir)};
const responses = ${JSON.stringify(responses)};
const callsFile = dir + "/calls.jsonl";
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const n = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, "utf8").split("\\n").filter(Boolean).length
    : 0;
  fs.appendFileSync(
    callsFile,
    JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin: input, cwd: process.cwd() }) + "\\n",
  );
  const r = responses[Math.min(n, responses.length - 1)];
  if (r.grandchild) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(dir + "/grandchild.pid", String(child.pid));
    child.unref();
  }
  for (const line of r.lines ?? []) process.stdout.write(JSON.stringify(line) + "\\n");
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.hang) {
    fs.writeFileSync(dir + "/child.pid", String(process.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = r.exitCode ?? 0;
});
`;
    await writeFile(binaryPath, script);
    await chmod(binaryPath, 0o755);
    return new FakeClaude(dir, binaryPath);
  }

  async calls(): Promise<FakeCall[]> {
    const file = join(this.dir, "calls.jsonl");
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall);
  }

  pid(name: "child" | "grandchild"): number {
    return Number(readFileSync(join(this.dir, `${name}.pid`), "utf8"));
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** A stream-json result event. */
export function resultLine(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s",
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
    },
    ...fields,
  };
}

/** Whether a process is still running. A zombie waiting to be reaped counts as gone. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

/** Waits up to `ms` for a process to be gone. */
export async function waitGone(pid: number, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isRunning(pid);
}
