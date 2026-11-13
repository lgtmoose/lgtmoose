import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the fake `codex` does on one invocation. */
export interface FakeCodexResponse {
  /** JSONL events written to stdout, one per line. */
  lines?: readonly unknown[];
  /** Written to the `-o` file, like Codex's final message. */
  lastMessage?: string;
  stderr?: string;
  exitCode?: number;
  /** Replaces `$CODEX_HOME/auth.json`, like a token refresh. */
  writeAuth?: string;
  /** Ignore SIGTERM and never exit. */
  hang?: boolean;
}

export interface FakeCodexCall {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  cwd: string;
  /** `$CODEX_HOME/auth.json` as the fake found it, if there was one. */
  authJson?: string;
  /** The `--output-schema` file's contents, if one was passed. */
  outputSchema?: string;
}

/**
 * A stand-in `codex` binary: a Node script that records how it was called and replies with
 * canned output. Invocation n gets `responses[n]`, or the last one once they run out.
 */
export class FakeCodex {
  private constructor(
    readonly dir: string,
    readonly binaryPath: string,
  ) {}

  static async create(responses: readonly FakeCodexResponse[]): Promise<FakeCodex> {
    const dir = await mkdtemp(join(tmpdir(), "lgtmoose-fake-codex-"));
    const binaryPath = join(dir, "codex");
    const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = ${JSON.stringify(dir)};
const responses = ${JSON.stringify(responses)};
const callsFile = dir + "/calls.jsonl";
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const n = fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, "utf8").split("\\n").filter(Boolean).length
    : 0;
  const authPath = path.join(process.env.CODEX_HOME || "/nonexistent", "auth.json");
  const schemaPath = flag("--output-schema");
  fs.appendFileSync(
    callsFile,
    JSON.stringify({
      argv,
      env: process.env,
      stdin: input,
      cwd: process.cwd(),
      authJson: fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : undefined,
      outputSchema: schemaPath && fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, "utf8") : undefined,
    }) + "\\n",
  );
  const r = responses[Math.min(n, responses.length - 1)];
  if (r.writeAuth !== undefined) fs.writeFileSync(authPath, r.writeAuth);
  for (const line of r.lines ?? []) process.stdout.write(JSON.stringify(line) + "\\n");
  const out = flag("-o");
  if (r.lastMessage !== undefined && out) fs.writeFileSync(out, r.lastMessage);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.hang) {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = r.exitCode ?? 0;
});
`;
    await writeFile(binaryPath, script);
    await chmod(binaryPath, 0o755);
    return new FakeCodex(dir, binaryPath);
  }

  async calls(): Promise<FakeCodexCall[]> {
    const file = join(this.dir, "calls.jsonl");
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCodexCall);
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** The events of a successful turn, with the answer as the agent's last message. */
export function codexTurn(answer: string, threadId = "thread-1"): unknown[] {
  return [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: answer } },
    {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
    },
  ];
}
