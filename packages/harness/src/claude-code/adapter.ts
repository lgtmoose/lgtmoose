import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  HarnessError,
  fullPrompt,
  type Harness,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessUsage,
} from "../harness.js";
import { exitText, saveAttemptTranscript, success } from "../attempt.js";
import { repairPrompt, schemaJson, schemaPromptSuffix, truncate } from "../answer.js";
import { runProcess, type ProcessResult } from "../process.js";
import { redact, valueContainsSecret } from "../redact.js";
import { transcriptKey, type TranscriptStore } from "../transcript.js";
import { addUsage } from "../usage.js";
import { claudeAuthEnv } from "./auth.js";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, TOOLS } from "./policy.js";
import { prepareClaudeSession } from "./session.js";
import {
  claudeLimitFailure,
  findResult,
  isAuthRetry,
  outputOf,
  usageOf,
  type ResultEvent,
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
/** Stop after this many API retries caused by the credential: retrying won't fix it. */
const MAX_AUTH_RETRIES = 2;

type Attempt<T> =
  | { kind: "ok"; output: T; usage: HarnessUsage; key: string }
  | { kind: "invalid"; problems: string; usage: HarnessUsage; key: string };

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
      const schema = jsonSchemaFor(options.schema);
      const sessionId = randomUUID();
      const secrets = auth.secrets;

      const attempt = async (n: number, prompt: string): Promise<Attempt<T>> => {
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
            ...(schema.flag === undefined ? {} : { jsonSchema: schema.flag }),
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
        failIfUnusable(proc, result, secrets, keys, options.timeoutMs);
        const usage = usageOf(result);
        if (result.subtype === "error_max_structured_output_retries") {
          return { kind: "invalid", problems: "No output matched the schema.", usage, key };
        }
        const parsed = outputOf(result);
        if (!parsed.ok) return { kind: "invalid", problems: parsed.error, usage, key };
        const checked = options.schema.safeParse(parsed.value);
        if (!checked.success) {
          return { kind: "invalid", problems: z.prettifyError(checked.error), usage, key };
        }
        // A prompt-injected model could try to post the credential in a finding.
        if (valueContainsSecret(checked.data, secrets)) {
          throw new HarnessError("invalid_output", "The output contained a model credential.", {
            transcriptKeys: keys,
          });
        }
        return { kind: "ok", output: checked.data, usage, key };
      };

      const first = await attempt(1, fullPrompt(options) + schema.promptSuffix);
      if (first.kind === "ok") return success(first, first.usage, keys);

      const second = await attempt(2, repairPrompt(first.problems));
      if (second.kind === "ok") return success(second, addUsage(first.usage, second.usage), keys);
      throw new HarnessError(
        "invalid_output",
        truncate(
          redact(`The output was invalid after a repair retry: ${second.problems}`, secrets),
        ),
        { transcriptKeys: keys },
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}

/** Throws the right HarnessError when a process didn't produce a successful result event. */
function failIfUnusable(
  proc: ProcessResult,
  result: ResultEvent | undefined,
  secrets: readonly string[],
  keys: readonly string[],
  timeoutMs: number,
): asserts result is ResultEvent {
  const fail = (kind: HarnessError["kind"], message: string): HarnessError =>
    new HarnessError(kind, truncate(redact(message, secrets)), { transcriptKeys: keys });
  if (proc.spawnError) throw fail("process", `Could not start claude: ${proc.spawnError.message}`);
  if (proc.stopped === "timeout") throw fail("timeout", `Timed out after ${timeoutMs} ms.`);
  if (proc.stopped === "requested") throw fail("auth", "The model API rejected the credential.");
  if (proc.stopped === "output_limit") {
    throw fail("process", "claude wrote more output than allowed.");
  }
  if (!result) {
    const detail = proc.stderr.trim() || "no output";
    throw fail("process", `claude exited (${exitText(proc)}) without a result: ${detail}`);
  }
  if (result.api_error_status === 401 || result.api_error_status === 403) {
    throw fail("auth", `The model API rejected the credential (HTTP ${result.api_error_status}).`);
  }
  // Running out of structured output retries is invalid output, which a repair retry can fix.
  if (result.subtype === "error_max_structured_output_retries") return;
  if (result.is_error || result.subtype !== "success") {
    const detail = result.result ?? result.errors?.join("; ") ?? "no detail";
    const limit = claudeLimitFailure(result, proc.stderr);
    if (limit !== undefined) {
      const { kind, ...extra } = limit;
      throw new HarnessError(kind, truncate(redact(`claude stopped: ${detail}`, secrets)), {
        transcriptKeys: keys,
        ...extra,
      });
    }
    throw fail("process", `claude reported ${result.subtype}: ${detail}`);
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

/**
 * How to ask for the schema. An object schema goes to `--json-schema`, which makes the CLI check
 * the answer too. Anything else is described in the prompt.
 */
function jsonSchemaFor(schema: z.ZodType): { flag?: string; promptSuffix: string } {
  const json = schemaJson(schema);
  if (json?.type === "object") return { flag: JSON.stringify(json), promptSuffix: "" };
  return { promptSuffix: schemaPromptSuffix(json) };
}
