import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake `agent` does on one invocation. */
export interface FakeCursorResponse {
  /** Written to stdout as is. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Ignore SIGTERM and never exit. */
  hang?: boolean;
  /** Writes an empty file at this path in the checkout, making its directories. */
  touch?: string;
}

export interface FakeCursorCall {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** `$HOME/.cursor/cli-config.json` as the fake found it. */
  cliConfig?: string;
  /** The entries at the checkout's root, sorted. */
  checkoutEntries: string[];
}

/**
 * A stand-in `agent` binary: a Node script that records how it was called and replies with
 * canned output. Invocation n gets `responses[n]`, or the last one once they run out.
 */
export class FakeCursor {
  private constructor(
    readonly dir: string,
    readonly binaryPath: string,
  ) {}

  static async create(responses: readonly FakeCursorResponse[]): Promise<FakeCursor> {
    const dir = await mkdtemp(join(tmpdir(), "lgtmoose-fake-cursor-"));
    const binaryPath = join(dir, "agent");
    const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = ${JSON.stringify(dir)};
const responses = ${JSON.stringify(responses)};
const callsFile = dir + "/calls.jsonl";
const n = fs.existsSync(callsFile)
  ? fs.readFileSync(callsFile, "utf8").split("\\n").filter(Boolean).length
  : 0;
const configPath = path.join(process.env.HOME || "/nonexistent", ".cursor", "cli-config.json");
fs.appendFileSync(
  callsFile,
  JSON.stringify({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    cliConfig: fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : undefined,
    checkoutEntries: fs.readdirSync(".").sort(),
  }) + "\\n",
);
const r = responses[Math.min(n, responses.length - 1)];
if (r.touch) {
  fs.mkdirSync(path.dirname(r.touch), { recursive: true });
  fs.writeFileSync(r.touch, "");
}
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
if (r.hang) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  process.exitCode = r.exitCode ?? 0;
}
`;
    await writeFile(binaryPath, script);
    await chmod(binaryPath, 0o755);
    return new FakeCursor(dir, binaryPath);
  }

  async calls(): Promise<FakeCursorCall[]> {
    const file = join(this.dir, "calls.jsonl");
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCursorCall);
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** The JSON a successful `agent -p --output-format json` run prints. */
export function cursorResult(answer: string, sessionId = "chat-1"): string {
  return `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 1100,
    result: answer,
    session_id: sessionId,
    request_id: "req-1",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5 },
  })}\n`;
}
