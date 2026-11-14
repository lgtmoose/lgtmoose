import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  query as sdkQuery,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type HookCallbackMatcher,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { repairPrompt, schemaJson, schemaPromptSuffix, truncate } from "../answer.js";
import { saveAttemptTranscript, success } from "../attempt.js";
import {
  HarnessError,
  type Harness,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessUsage,
} from "../harness.js";
import type { ProcessResult } from "../process.js";
import { redact, valueContainsSecret } from "../redact.js";
import { transcriptKey, type TranscriptStore } from "../transcript.js";
import { addUsage } from "../usage.js";
import { claudeAuthEnv, type ClaudeAuthEnv } from "../claude-code/auth.js";
import {
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  isAllowedGitCommand,
  TOOLS,
} from "../claude-code/policy.js";
import { prepareClaudeSession } from "../claude-code/session.js";
import {
  claudeLimitFailure,
  findResult,
  outputOf,
  usageOf,
  type ResultEvent,
} from "../claude-code/stream.js";

/** The Agent SDK's `query`, injectable so tests can run without the CLI. */
export type AgentQuery = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

export interface AgentSdkHarnessOptions {
  /** Where each attempt's messages are saved, one JSON object per line. */
  transcripts: TranscriptStore;
  /**
   * The Claude Code binary the SDK runs. Defaults to the one the SDK bundles; the sandbox passes
   * the pinned `claude` it installs (`CLAUDE_CODE_VERSION`), the same version the SDK tracks.
   */
  binaryPath?: string;
  /** Where credentials, PATH and proxy settings come from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** No limit by default; the timeout still applies. */
  maxTurns?: number;
  /** Parent of each run's temporary home directory. Defaults to the OS temp directory. */
  tmpRoot?: string;
  /** Defaults to the SDK's `query`. */
  query?: AgentQuery;
}

/** Stop a run whose messages pass this size. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Kept from the CLI's stderr for errors and transcripts. */
const MAX_STDERR_CHARS = 64 * 1024;

type Attempt<T> =
  | { kind: "ok"; output: T; usage: HarnessUsage; key: string }
  | { kind: "invalid"; problems: string; usage: HarnessUsage; key: string };

/**
 * Runs a review through the Claude Agent SDK with the same read-only policy as the claude-code
 * harness: only Read, Grep, Glob and Bash exist, `dontAsk` refuses anything not allowed, the
 * file tools stay inside the checkout (`--restricted`), and every Bash call goes through the
 * git guard, both as the settings hook and as an in-process PreToolUse hook. On top of the
 * CLI harness it takes `system` as a cached system prompt.
 *
 * Auth: an API key, Bedrock (the task role) or Vertex. Not a Claude subscription: Anthropic's
 * terms don't allow claude.ai sign-in for products built on the Agent SDK.
 */
export class AgentSdkHarness implements Harness {
  readonly id = "agent-sdk";
  private readonly options: AgentSdkHarnessOptions;

  constructor(options: AgentSdkHarnessOptions) {
    this.options = options;
  }

  async run<T>(options: HarnessRunOptions<T>): Promise<HarnessResult<T>> {
    const source = this.options.env ?? process.env;
    const auth = sdkAuth(source);
    const runId = options.runId ?? randomUUID();
    const deadline = Date.now() + options.timeoutMs;
    const home = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), "lgtmoose-agent-sdk-"));
    const keys: string[] = [];
    const secrets = auth.secrets;
    const query = this.options.query ?? (sdkQuery as AgentQuery);
    try {
      const session = await prepareClaudeSession(home, source, auth);
      const json = schemaJson(options.schema);
      const outputFormat =
        json?.type === "object" ? { type: "json_schema" as const, schema: json } : undefined;
      const promptSuffix = outputFormat === undefined ? schemaPromptSuffix(json) : "";
      const sessionId = randomUUID();

      const attempt = async (n: number, prompt: string): Promise<Attempt<T>> => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) {
          throw new HarnessError("timeout", `Timed out after ${options.timeoutMs} ms.`, {
            transcriptKeys: keys,
          });
        }
        const sdkOptions: Options = {
          cwd: options.cwd,
          ...(options.model.trim() === "" ? {} : { model: options.model }),
          ...(options.system === undefined
            ? {}
            : { systemPrompt: [options.system, SYSTEM_PROMPT_DYNAMIC_BOUNDARY] }),
          ...(outputFormat === undefined ? {} : { outputFormat }),
          ...(this.options.binaryPath === undefined
            ? {}
            : { pathToClaudeCodeExecutable: this.options.binaryPath }),
          ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
          ...(n > 1 ? { resume: sessionId } : { sessionId }),
          env: session.env,
          tools: TOOLS,
          allowedTools: ALLOWED_TOOLS,
          disallowedTools: DISALLOWED_TOOLS,
          permissionMode: "dontAsk",
          permissionPrompts: "none",
          // No settings files from the checkout or anywhere else; only the run's own layer.
          settingSources: [],
          settings: session.settings,
          // No MCP servers, including any in the checkout's .mcp.json.
          strictMcpConfig: true,
          mcpServers: {},
          hooks: { PreToolUse: [gitGuardHook()] },
          // Confines the file tools to the checkout, and no slash commands, as `claudeArgs`.
          extraArgs: { restricted: null, "disable-slash-commands": null },
        };
        const run = await collect(query, prompt, sdkOptions, timeoutMs, secrets);
        const key = transcriptKey(runId, n);
        await saveAttemptTranscript(this.options.transcripts, key, run.proc, n, secrets, keys);
        const result = findResult(run.proc.stdout);
        failIfUnusable(run, result, secrets, keys, options.timeoutMs);
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

      const first = await attempt(1, options.prompt + promptSuffix);
      if (first.kind === "ok") return success(first, first.usage, keys);
      // Resume the session so the model sees its own answer.
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

/** The SDK's credential: never a claude.ai OAuth token (see `AgentSdkHarness`). */
function sdkAuth(source: Readonly<Record<string, string | undefined>>): ClaudeAuthEnv {
  const auth = claudeAuthEnv(source);
  if (auth.method === "oauth_token") {
    throw new HarnessError(
      "auth",
      "The agent-sdk harness takes an API key, Bedrock or Vertex, not a Claude subscription token. Use the claude-code harness for that.",
    );
  }
  return auth;
}

/**
 * The git guard as an in-process PreToolUse hook: every Bash call must be a plain `git diff`,
 * `git log` or `git show` (`isAllowedGitCommand`). A second copy of the settings hook, so the
 * policy holds even if the settings layer didn't load.
 */
export function gitGuardHook(): HookCallbackMatcher {
  return {
    matcher: "Bash",
    hooks: [
      async (input) => {
        const command =
          input.hook_event_name === "PreToolUse" &&
          typeof (input.tool_input as { command?: unknown } | null)?.command === "string"
            ? (input.tool_input as { command: string }).command
            : undefined;
        if (command !== undefined && isAllowedGitCommand(command)) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "Only plain `git diff`, `git log` and `git show` run in a review.",
          },
        };
      },
    ],
  };
}

interface CollectedRun {
  proc: ProcessResult;
  /** The SDK threw, or the run was stopped: why. */
  error?: unknown;
}

/**
 * Runs one query and collects its messages as JSON lines, the same shape as the CLI's
 * stream-json, so the claude-code stream helpers read it. Stops it at the deadline or when its
 * output passes `MAX_OUTPUT_BYTES`.
 */
async function collect(
  query: AgentQuery,
  prompt: string,
  options: Options,
  timeoutMs: number,
  secrets: readonly string[],
): Promise<CollectedRun> {
  const controller = new AbortController();
  let stopped: ProcessResult["stopped"];
  const timer = setTimeout(() => {
    stopped = "timeout";
    controller.abort();
  }, timeoutMs);
  let stderr = "";
  const lines: string[] = [];
  let bytes = 0;
  let error: unknown;
  try {
    const messages = query({
      prompt,
      options: {
        ...options,
        abortController: controller,
        stderr: (data) => {
          if (stderr.length < MAX_STDERR_CHARS)
            stderr += data.slice(0, MAX_STDERR_CHARS - stderr.length);
        },
      },
    });
    for await (const message of messages) {
      const line = JSON.stringify(message);
      bytes += Buffer.byteLength(line) + 1;
      lines.push(line);
      if (bytes > MAX_OUTPUT_BYTES) {
        stopped = "output_limit";
        controller.abort();
        break;
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    clearTimeout(timer);
  }
  const stdout = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return {
    proc: {
      stdout,
      stderr: redact(stderr, secrets),
      exitCode: error === undefined && stopped === undefined ? 0 : 1,
      signal: null,
      ...(stopped === undefined ? {} : { stopped }),
    },
    ...(error === undefined ? {} : { error }),
  };
}

/** Throws the right HarnessError when a run didn't produce a successful result. */
function failIfUnusable(
  run: CollectedRun,
  result: ResultEvent | undefined,
  secrets: readonly string[],
  keys: readonly string[],
  timeoutMs: number,
): asserts result is ResultEvent {
  const fail = (kind: HarnessError["kind"], message: string): HarnessError =>
    new HarnessError(kind, truncate(redact(message, secrets)), { transcriptKeys: keys });
  const { proc } = run;
  if (proc.stopped === "timeout") throw fail("timeout", `Timed out after ${timeoutMs} ms.`);
  if (proc.stopped === "output_limit")
    throw fail("process", "The run wrote more output than allowed.");
  if (!result) {
    const why = run.error instanceof Error ? run.error.message : proc.stderr.trim() || "no output";
    throw fail("process", `The Agent SDK run ended without a result: ${why}`);
  }
  if (result.api_error_status === 401 || result.api_error_status === 403) {
    throw fail("auth", `The model API rejected the credential (HTTP ${result.api_error_status}).`);
  }
  if (result.subtype === "error_max_structured_output_retries") return;
  if (result.is_error || result.subtype !== "success") {
    const detail = result.result ?? result.errors?.join("; ") ?? "no detail";
    const limit = claudeLimitFailure(result, proc.stderr);
    if (limit !== undefined) {
      const { kind, ...extra } = limit;
      throw new HarnessError(kind, truncate(redact(`The model stopped: ${detail}`, secrets)), {
        transcriptKeys: keys,
        ...extra,
      });
    }
    throw fail("process", `The Agent SDK run reported ${result.subtype}: ${detail}`);
  }
}
