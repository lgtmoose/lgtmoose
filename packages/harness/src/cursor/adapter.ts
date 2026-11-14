import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
import type { LimitFailure } from "../limits.js";
import { cursorAuth } from "./auth.js";
import { cursorCliConfig } from "./policy.js";
import {
  classifyCursorFailure,
  classifyStrictCursorFailure,
  isGenericError,
  cursorUsage,
  findCursorResult,
  type CursorResult,
} from "./result.js";
import { copyWorkspace, type WorkspaceCopy } from "./workspace.js";

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
  /**
   * Parent of each run's temporary directory, which holds its home and its copy of the checkout.
   * Defaults to the OS temp directory.
   */
  tmpRoot?: string;
}

/** Stop a run whose output passes this size. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/**
 * The CLI takes the prompt as an argument, not on stdin, and Linux caps one argument at 128 KiB
 * (MAX_ARG_STRLEN). A prompt up to this size goes on the command line; a longer one is written
 * to a task file in the workspace, and the command line tells the model to read it.
 */
export const MAX_CURSOR_ARG_PROMPT_BYTES = 120 * 1024;
/**
 * The largest prompt accepted at all: past this, reading the task file would take the model
 * more turns than a review has. Larger fails as `input_too_large`, which the fallback chain moves
 * on from.
 */
export const MAX_CURSOR_PROMPT_BYTES = 4 * 1024 * 1024;

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
 * `--approve-mcps`. A trusted workspace loads its hooks, config and rules, so the run's workspace
 * is a copy of the checkout without them (`copyWorkspace`). The prompt comes last, after `--`, so
 * a prompt starting with `-` isn't read as a flag.
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

/**
 * Runs the Cursor CLI headless (`agent -p`) in read-only ask mode, on a copy of the checkout in
 * the run's temporary directory, which the repair attempt reuses and which goes when the run
 * ends. The caller's tree is never changed.
 */
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
    const schemaSuffix = schemaPromptSuffix(schemaJson(options.schema));
    // Before copying anything; the note about the copy adds a sentence, checked again below.
    checkPromptSize(options.prompt + schemaSuffix, keys);
    const root = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), "lgtmoose-cursor-"));
    try {
      const { dir: workspace, copy } = await copyCheckout(options.cwd, root, keys);
      const firstPrompt = options.prompt + copyNote(copy) + schemaSuffix;
      checkPromptSize(firstPrompt, keys);
      const taskDir = await freeTaskDir(workspace);
      const home = join(root, "home");
      await mkdir(join(home, ".cursor"), { recursive: true });
      await mkdir(join(home, "tmp"));
      await writeFile(join(home, ".cursor", "cli-config.json"), cursorCliConfig(workspace));
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
        const proc = await runProcess({
          command: this.options.binaryPath ?? "agent",
          args: cursorArgs({
            ...(model === undefined ? {} : { model }),
            ...(sessionId === undefined ? {} : { resumeSessionId: sessionId }),
            prompt: await deliver(workspace, taskDir, n, prompt),
          }),
          cwd: workspace,
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
      await rm(root, { recursive: true, force: true });
    }
  }
}

/**
 * Copies the checkout at `cwd` into the run's `root` (see `copyWorkspace`), returning the copy's
 * real path, which is the CLI's working directory and its read allowlist. A failure is a
 * `process` HarnessError.
 */
async function copyCheckout(
  cwd: string,
  root: string,
  keys: readonly string[],
): Promise<{ dir: string; copy: WorkspaceCopy }> {
  try {
    const copy = await copyWorkspace(cwd, join(root, "checkout"));
    return { dir: await realpath(join(root, "checkout")), copy };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HarnessError("process", `Could not copy the checkout for the CLI: ${message}`, {
      transcriptKeys: keys,
      cause: error,
    });
  }
}

/** Tells the model what the copy it can read leaves out, when it leaves anything out. */
function copyNote(copy: WorkspaceCopy): string {
  const parts = [
    copy.links > 0 ? `${copy.links} symlink${copy.links === 1 ? "" : "s"}` : undefined,
    copy.unreadable > 0
      ? `${copy.unreadable} unreadable entr${copy.unreadable === 1 ? "y" : "ies"}`
      : undefined,
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return `\n\nThe checkout you can read leaves out ${parts.join(" and ")}. Their changes, if any, are in the diff above.`;
}

/**
 * A directory name for the run's task files in the workspace: not a dot name (globs and ignore
 * rules may skip those), random, and not already in the copy.
 */
async function freeTaskDir(workspace: string): Promise<string> {
  for (;;) {
    const name = `lgtmoose-task-${randomUUID()}`;
    const taken = await lstat(join(workspace, name)).then(
      () => true,
      () => false,
    );
    if (!taken) return name;
  }
}

/** Refuses a prompt too large to review at all (`MAX_CURSOR_PROMPT_BYTES`). */
function checkPromptSize(prompt: string, keys: readonly string[]): void {
  const bytes = Buffer.byteLength(prompt);
  if (bytes <= MAX_CURSOR_PROMPT_BYTES) return;
  throw new HarnessError(
    "input_too_large",
    `The prompt is ${bytes} bytes; the cursor-agent harness takes at most ${MAX_CURSOR_PROMPT_BYTES}. Split the batch, or review it with another provider.`,
    { transcriptKeys: keys },
  );
}

/**
 * What goes on the command line for attempt `n`: the prompt itself when it fits in one argument
 * (`MAX_CURSOR_ARG_PROMPT_BYTES`), otherwise a pointer to a task file holding it, which the
 * model reads with its Read tool. The file sits in the workspace, where reads are allowed, in
 * the run's own task directory (`freeTaskDir`).
 */
async function deliver(workspace: string, taskDir: string, n: number, prompt: string) {
  if (Buffer.byteLength(prompt) <= MAX_CURSOR_ARG_PROMPT_BYTES) return prompt;
  const file = `${taskDir}/prompt-${n}.md`;
  await mkdir(join(workspace, taskDir), { recursive: true });
  await writeFile(join(workspace, file), prompt);
  return [
    `Your task is in the file ${file}, which is too long to send here.`,
    "Read all of it with the Read tool, in parts until its end, then do exactly what it says.",
    "Don't review that file itself: it isn't part of the checkout.",
  ].join(" ");
}

/** Whether a failed run hit a limit or a refused key, from its error result and stderr. */
function classifyRun(
  errorText: string | undefined,
  stderr: string | undefined,
): LimitFailure | undefined {
  if (errorText === undefined)
    return stderr === undefined ? undefined : classifyCursorFailure(stderr);
  const fromResult = classifyCursorFailure(errorText);
  if (fromResult !== undefined || stderr === undefined || !isGenericError(errorText)) {
    return fromResult;
  }
  return classifyStrictCursorFailure(stderr);
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
  // The classifiers read a long result text's start and end (`HeadTail`), as stderr is kept.
  const errorText = (result?.is_error === true ? result.result : undefined)?.trim() || undefined;
  const stderr = proc.stderr.trim() || undefined;
  const detail = [errorText, stderr].filter(Boolean).join("\n") || "no output";
  // The JSON error result says what went wrong when there is one. If it's too generic to say
  // ("Request failed"), stderr may still give a machine signal (a connect code or an HTTP status),
  // but never its wording, which a banner or warning could contain. Without an error result,
  // stderr is all there is.
  const limit = classifyRun(errorText, stderr);
  if (limit !== undefined) {
    const { kind, ...extra } = limit;
    throw fail(kind, `agent stopped: ${detail}`, extra);
  }
  throw fail("process", `agent exited (${exitText(proc)}) without a result: ${detail}`);
}
