import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseAnswer, repairPrompt, schemaJson, schemaPromptSuffix, truncate } from "../answer.js";
import { exitText, saveAttemptTranscript, success } from "../attempt.js";
import { isolatedEnv, networkEnv } from "../env.js";
import {
  HarnessError,
  type Harness,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessUsage,
  type ModelTier,
} from "../harness.js";
import { runProcess, type ProcessResult } from "../process.js";
import { redact, valueContainsSecret } from "../redact.js";
import { transcriptKey, type TranscriptStore } from "../transcript.js";
import { addUsage } from "../usage.js";
import { cursorAuth } from "./auth.js";
import { CURSOR_PROJECT_CONFIG_DIRS, cursorCliConfig } from "./policy.js";
import {
  classifyCursorFailure,
  cursorUsage,
  findCursorResult,
  type CursorResult,
} from "./result.js";

export interface CursorHarnessOptions {
  /** Where each attempt's output is saved. */
  transcripts: TranscriptStore;
  /** The `agent` binary. Defaults to `agent` on PATH. */
  binaryPath?: string;
  /** Where the key, PATH and proxy settings come from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Models per tier, from the provider's `models` in lgtmoose.config.ts. A run's `model` wins;
   * without either, the CLI uses the account's default model.
   */
  models?: Partial<Record<ModelTier, string>>;
  /** Time between SIGTERM and SIGKILL on timeout. Defaults to 5 seconds. */
  killGraceMs?: number;
  /** Parent of each run's temporary home directory. Defaults to the OS temp directory. */
  tmpRoot?: string;
  /**
   * Called when the checkout's set-aside config directories couldn't be put back after the run.
   * The run's own outcome stands either way: the checkout is the task's own and is thrown away.
   */
  onRestoreError?: (error: unknown) => void;
}

/** Stop a run whose output passes this size. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/**
 * The CLI takes the prompt as an argument, not on stdin, and Linux caps one argument at 128 KiB
 * (MAX_ARG_STRLEN, counting the closing NUL).
 */
const MAX_ARG_BYTES = 128 * 1024 - 1;
/**
 * The largest first prompt (the batch and the schema) accepted, leaving room under
 * `MAX_ARG_BYTES` for the repair text when a fresh-start repair has to repeat it.
 */
export const MAX_CURSOR_PROMPT_BYTES = 120 * 1024;

export interface CursorArgsOptions {
  /** Omit for the account's default model. */
  model?: string;
  /** Continue this chat (the repair retry) instead of starting one. */
  resumeSessionId?: string;
  prompt: string;
}

/**
 * The command line (flags from https://cursor.com/docs/cli/reference/parameters): print mode
 * with one JSON result, ask mode (read-only), the workspace trusted without a prompt, and the
 * sandbox on. Never `--force` (it applies changes and runs commands without asking) and never
 * `--approve-mcps`, so MCP servers in the checkout's `.cursor/mcp.json` don't start. Trusting
 * the workspace would load its hooks and config, so the run sets those directories aside first
 * (`CURSOR_PROJECT_CONFIG_DIRS`). The prompt comes last, after `--`, so a prompt starting with
 * `-` isn't read as a flag.
 */
export function cursorArgs(options: CursorArgsOptions): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--trust",
    "--sandbox",
    "enabled",
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.resumeSessionId === undefined ? [] : ["--resume", options.resumeSessionId]),
    "--",
    options.prompt,
  ];
}

type Attempt<T> =
  | { kind: "ok"; output: T; usage: HarnessUsage; key: string }
  | { kind: "invalid"; problems: string; usage: HarnessUsage; key: string };

/** Runs the Cursor CLI headless (`agent -p`) in read-only ask mode. */
export class CursorHarness implements Harness {
  readonly id = "cursor-agent";
  private readonly options: CursorHarnessOptions;

  constructor(options: CursorHarnessOptions) {
    this.options = options;
  }

  async run<T>(options: HarnessRunOptions<T>): Promise<HarnessResult<T>> {
    const source = this.options.env ?? process.env;
    const auth = cursorAuth(source);
    const runId = options.runId ?? randomUUID();
    const deadline = Date.now() + options.timeoutMs;
    const tier = options.tier ?? "standard";
    const model = options.model.trim() || this.options.models?.[tier];
    const secrets = auth.secrets;
    const keys: string[] = [];
    // No structured-output flag: the schema is described in the prompt, and checked with zod.
    const firstPrompt = options.prompt + schemaPromptSuffix(schemaJson(options.schema));
    checkPromptSize(firstPrompt, MAX_CURSOR_PROMPT_BYTES, keys);
    const home = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), "lgtmoose-cursor-"));
    const setAside: { from: string; to: string }[] = [];
    try {
      await setAsideProjectConfig(options.cwd, setAside);
      await mkdir(join(home, ".cursor"));
      await mkdir(join(home, "tmp"));
      await writeFile(join(home, ".cursor", "cli-config.json"), cursorCliConfig(options.cwd));
      const env: Record<string, string> = {
        PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...networkEnv(source),
        ...auth.env,
        ...isolatedEnv(home),
        NO_COLOR: "1",
      };

      let sessionId: string | undefined;
      const attempt = async (n: number, prompt: string): Promise<Attempt<T>> => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) {
          throw new HarnessError("timeout", `Timed out after ${options.timeoutMs} ms.`, {
            transcriptKeys: keys,
          });
        }
        checkPromptSize(prompt, MAX_ARG_BYTES, keys);
        const proc = await runProcess({
          command: this.options.binaryPath ?? "agent",
          args: cursorArgs({
            ...(model === undefined ? {} : { model }),
            ...(sessionId === undefined ? {} : { resumeSessionId: sessionId }),
            prompt,
          }),
          cwd: options.cwd,
          env,
          input: "",
          timeoutMs,
          killGraceMs: this.options.killGraceMs ?? 5000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        });
        const key = transcriptKey(runId, n);
        await saveAttemptTranscript(this.options.transcripts, key, proc, n, secrets, keys);
        const result = findCursorResult(proc.stdout);
        failIfUnusable(proc, result, secrets, keys, options.timeoutMs);
        sessionId = result.session_id ?? sessionId;
        const usage = cursorUsage(result);
        const parsed = parseAnswer(result.result);
        if (!parsed.ok) return { kind: "invalid", problems: parsed.error, usage, key };
        const checked = options.schema.safeParse(parsed.value);
        if (!checked.success) {
          return { kind: "invalid", problems: z.prettifyError(checked.error), usage, key };
        }
        // A prompt-injected model could try to post the key in a finding.
        if (valueContainsSecret(checked.data, secrets)) {
          throw new HarnessError("invalid_output", "The output contained a model credential.", {
            transcriptKeys: keys,
          });
        }
        return { kind: "ok", output: checked.data, usage, key };
      };

      const first = await attempt(1, firstPrompt);
      if (first.kind === "ok") return success(first, first.usage, keys);
      // Resume the chat so the model sees its answer; without a session id, start over with the
      // problems appended.
      const repair = repairPrompt(first.problems);
      const second = await attempt(
        2,
        sessionId === undefined ? `${firstPrompt}\n\n${repair}` : repair,
      );
      if (second.kind === "ok") return success(second, addUsage(first.usage, second.usage), keys);
      throw new HarnessError(
        "invalid_output",
        truncate(
          redact(`The output was invalid after a repair retry: ${second.problems}`, secrets),
        ),
        { transcriptKeys: keys },
      );
    } finally {
      await restoreProjectConfig(setAside, this.options.onRestoreError);
      await rm(home, { recursive: true, force: true });
    }
  }
}

/**
 * Renames the checkout's config directories (`CURSOR_PROJECT_CONFIG_DIRS`) out of the CLI's way
 * for the run, recording each in `moved` so they can be put back. Fails the run if one can't be
 * moved. The prompt still holds their diff. Not safe for two runs at once on one checkout, which
 * the sandbox never does: each task reviews one batch in its own checkout.
 */
async function setAsideProjectConfig(
  cwd: string,
  moved: { from: string; to: string }[],
): Promise<void> {
  for (const dir of CURSOR_PROJECT_CONFIG_DIRS) {
    const from = join(cwd, dir);
    const exists = await lstat(from).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    const to = `${from}.lgtmoose-${randomUUID()}`;
    try {
      await rename(from, to);
    } catch (error) {
      throw new HarnessError("process", `Could not set aside ${dir} in the checkout.`, {
        cause: error,
      });
    }
    moved.push({ from, to });
  }
}

/**
 * Puts back what `setAsideProjectConfig` moved, all it can. A failure goes to `onError` and
 * doesn't replace the run's outcome.
 */
async function restoreProjectConfig(
  moved: readonly { from: string; to: string }[],
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  const results = await Promise.allSettled(moved.map(({ from, to }) => rename(to, from)));
  for (const result of results) {
    if (result.status === "rejected") onError?.(result.reason);
  }
}

/**
 * Refuses a prompt longer than `limit` bytes, which the kernel may not pass as one argument. The
 * fallback chain moves on to a provider that takes the prompt on stdin.
 */
function checkPromptSize(prompt: string, limit: number, keys: readonly string[]): void {
  const bytes = Buffer.byteLength(prompt);
  if (bytes <= limit) return;
  throw new HarnessError(
    "input_too_large",
    `The prompt is ${bytes} bytes; the Cursor CLI takes at most ${limit}. Use smaller batches.`,
    { transcriptKeys: keys },
  );
}

/** Throws the right HarnessError when a run didn't print a successful result. */
function failIfUnusable(
  proc: ProcessResult,
  result: CursorResult | undefined,
  secrets: readonly string[],
  keys: readonly string[],
  timeoutMs: number,
): asserts result is CursorResult {
  const fail = (
    kind: HarnessError["kind"],
    message: string,
    extra: { retryAfterSeconds?: number; resetsAt?: string } = {},
  ): HarnessError =>
    new HarnessError(kind, truncate(redact(message, secrets)), { transcriptKeys: keys, ...extra });
  if (proc.spawnError) throw fail("process", `Could not start agent: ${proc.spawnError.message}`);
  if (proc.stopped === "timeout") throw fail("timeout", `Timed out after ${timeoutMs} ms.`);
  if (proc.stopped === "output_limit") {
    throw fail("process", "agent wrote more output than allowed.");
  }
  const ok =
    result !== undefined &&
    proc.exitCode === 0 &&
    result.subtype === "success" &&
    result.is_error !== true;
  if (ok) return;
  // Both: a warning on stderr mustn't hide a limit the error result names.
  const detail =
    [result?.is_error === true ? result.result : undefined, proc.stderr]
      .map((text) => text?.trim())
      .filter(Boolean)
      .join("\n") || "no output";
  const limit = classifyCursorFailure(detail);
  if (limit !== undefined) {
    const { kind, ...extra } = limit;
    throw fail(kind, `agent stopped: ${detail}`, extra);
  }
  throw fail("process", `agent exited (${exitText(proc)}) without a result: ${detail}`);
}
