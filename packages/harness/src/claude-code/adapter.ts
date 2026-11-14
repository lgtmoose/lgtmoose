import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessError,
  fullPrompt,
  type Harness,
  type HarnessResult,
  type HarnessRunOptions,
} from "../harness.js";
import { exitText, saveAttemptTranscript } from "../attempt.js";
import { runProcess } from "../process.js";
import { transcriptKey, type TranscriptStore } from "../transcript.js";
import { claudeAuthEnv } from "./auth.js";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, TOOLS } from "./policy.js";
import { prepareClaudeSession, removeRunHome } from "./session.js";
import {
  MAX_AUTH_RETRIES,
  checkAnswer,
  claudeSchemaFor,
  failIfUnusable,
  findResult,
  isAuthRetry,
  withRepair,
  type ClaudeAttempt,
} from "./stream.js";

export interface ClaudeCodeHarnessOptions {
  /** Where each attempt's stream-json transcript is saved. */
  transcripts: TranscriptStore;
  /** The `claude` binary. Defaults to `claude` on PATH. */
  binaryPath?: string;
  /** Where credentials, PATH and proxy settings come from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Passed as `--max-turns`. No limit by default; the timeout still applies. */
  maxTurns?: number;
  /** Time between SIGTERM and SIGKILL on timeout. Defaults to 5 seconds. */
  killGraceMs?: number;
  /**
   * Sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which strips credentials from the environment of
   * Bash commands and runs them in a bubblewrap sandbox. Needs `bwrap` and `socat` in the image
   * and user namespaces on the host. Off by default.
   */
  scrubSubprocessEnv?: boolean;
  /** Parent of each run's temporary home directory. Defaults to the OS temp directory. */
  tmpRoot?: string;
}

/** Stop a run whose stream-json passes this size. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Runs Claude Code headless (`claude -p`) with read-only tools. */
export class ClaudeCodeHarness implements Harness {
  readonly id = "claude-code";
  private readonly options: ClaudeCodeHarnessOptions;

  constructor(options: ClaudeCodeHarnessOptions) {
    this.options = options;
  }

  async run<T>(options: HarnessRunOptions<T>): Promise<HarnessResult<T>> {
    const source = this.options.env ?? process.env;
    const auth = claudeAuthEnv(source);
    const runId = options.runId ?? randomUUID();
    const deadline = Date.now() + options.timeoutMs;
    const home = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), "lgtmoose-claude-"));
    const keys: string[] = [];
    try {
      const session = await prepareClaudeSession(
        home,
        source,
        auth,
        this.options.scrubSubprocessEnv === undefined
          ? {}
          : { scrubSubprocessEnv: this.options.scrubSubprocessEnv },
      );
      const settings = JSON.stringify(session.settings);
      const env = session.env;
      const schema = claudeSchemaFor(options.schema);
      const sessionId = randomUUID();
      const secrets = auth.secrets;

      const attempt = async (n: number, prompt: string): Promise<ClaudeAttempt<T>> => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) {
          throw new HarnessError("timeout", `Timed out after ${options.timeoutMs} ms.`, {
            transcriptKeys: keys,
          });
        }
        let authRetries = 0;
        const proc = await runProcess({
          command: this.options.binaryPath ?? "claude",
          args: claudeArgs({
            model: options.model,
            settings,
            sessionId,
            resume: n > 1,
            ...(schema.json === undefined ? {} : { jsonSchema: JSON.stringify(schema.json) }),
            ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
          }),
          cwd: options.cwd,
          env,
          input: prompt,
          timeoutMs,
          killGraceMs: this.options.killGraceMs ?? 5000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          secrets,
          onLine: (line) => {
            if (isAuthRetry(line)) authRetries++;
            return authRetries >= MAX_AUTH_RETRIES ? "kill" : undefined;
          },
        });
        const key = transcriptKey(runId, n);
        await saveAttemptTranscript(this.options.transcripts, key, proc, n, secrets, keys);
        const result = findResult(proc.stdout);
        failIfUnusable(proc, result, {
          secrets,
          keys,
          timeoutMs: options.timeoutMs,
          name: "claude",
          noResult: () =>
            `claude exited (${exitText(proc)}) without a result: ${proc.stderr.trim() || "no output"}`,
        });
        return checkAnswer(result, options.schema, secrets, keys, key);
      };

      return await withRepair(attempt, fullPrompt(options) + schema.promptSuffix, secrets, keys);
    } finally {
      await removeRunHome(home);
    }
  }
}

export interface ClaudeArgsOptions {
  model: string;
  /** Inline JSON for `--settings`. */
  settings: string;
  sessionId: string;
  /** Continue `sessionId` instead of starting it. */
  resume: boolean;
  jsonSchema?: string;
  maxTurns?: number;
}

/** The command line. The prompt goes on stdin. */
export function claudeArgs(options: ClaudeArgsOptions): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // No model (a fallback chain with no model for the tier): Claude Code's own default.
    ...(options.model.trim() === "" ? [] : ["--model", options.model]),
    // Only managed settings and --settings load; file tools stay inside the checkout.
    "--restricted",
    "--tools",
    TOOLS.join(","),
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--disallowedTools",
    ...DISALLOWED_TOOLS,
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    // No MCP servers, including any in the checkout's .mcp.json.
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    options.settings,
    "--disable-slash-commands",
  ];
  if (options.resume) args.push("--resume", options.sessionId);
  else args.push("--session-id", options.sessionId);
  if (options.jsonSchema !== undefined) args.push("--json-schema", options.jsonSchema);
  if (options.maxTurns !== undefined) args.push("--max-turns", String(options.maxTurns));
  return args;
}
