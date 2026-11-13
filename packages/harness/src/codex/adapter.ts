import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  HarnessError,
  type Harness,
  type HarnessResult,
  type HarnessRunOptions,
  type HarnessUsage,
  type ModelTier,
} from "../harness.js";
import { networkEnv } from "../claude-code/auth.js";
import { runProcess, type ProcessResult } from "../process.js";
import { redact, valueContainsSecret, withheldLines } from "../redact.js";
import { transcriptKey, type TranscriptStore } from "../transcript.js";
import { authJsonSecrets, codexAuth } from "./auth.js";
import { dropOptionalNulls, strictSchema } from "./schema.js";
import { addUsage, classifyFailure, parseCodexEvents, type CodexRun } from "./stream.js";

export interface CodexHarnessOptions {
  /** Where each attempt's JSONL transcript is saved. */
  transcripts: TranscriptStore;
  /** The `codex` binary. Defaults to `codex` on PATH. */
  binaryPath?: string;
  /** Where credentials, PATH and proxy settings come from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Models per tier, from the provider's `models` in lgtmoose.config.ts. A run's `model` wins;
   * without either, Codex uses its own default model at the tier's reasoning effort.
   */
  models?: Partial<Record<ModelTier, string>>;
  /**
   * Called after a run with a ChatGPT sign-in when Codex refreshed its tokens, with the new
   * `auth.json`, so the credential broker can store it. Not called when nothing changed.
   */
  onAuthRefreshed?: (authJson: string) => Promise<void> | void;
  /** Time between SIGTERM and SIGKILL on timeout. Defaults to 5 seconds. */
  killGraceMs?: number;
  /** Parent of each run's temporary home directory. Defaults to the OS temp directory. */
  tmpRoot?: string;
}

/** Reasoning effort per tier (Codex's `model_reasoning_effort`). */
export const CODEX_REASONING_EFFORT: Readonly<Record<ModelTier, string>> = {
  fast: "low",
  standard: "medium",
  deep: "high",
};

/** Stop a run whose JSONL passes this size. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Stop after this many error events that say the credential was refused. */
const MAX_AUTH_ERRORS = 2;
const MAX_MESSAGE = 2000;

type Attempt<T> =
  | { kind: "ok"; output: T; usage: HarnessUsage; key: string }
  | { kind: "invalid"; problems: string; usage: HarnessUsage; key: string };

export interface CodexArgsOptions {
  /** Omit for Codex's default model. */
  model?: string;
  reasoningEffort: string;
  /** The strict JSON Schema file for `--output-schema`. */
  outputSchemaPath?: string;
  /** Where `-o` writes the final message. */
  lastMessagePath: string;
  /** Continue this thread (the repair retry) instead of starting one. */
  resumeThreadId?: string;
}

/**
 * Settings for every run, as `-c` overrides (checked against Codex 0.166): never ask for
 * approval, a read-only sandbox for commands (no writes, no network), no web search, no
 * AGENTS.md or other project docs from the checkout (they're PR content), no secrets in the
 * environment of the commands the model runs, no update check, and credentials in the
 * `auth.json` file rather than a keyring.
 */
const CONFIG = [
  'approval_policy="never"',
  'sandbox_mode="read-only"',
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  'shell_environment_policy.inherit="core"',
  "check_for_update_on_startup=false",
  'cli_auth_credentials_store="file"',
];

/** The command line. The prompt goes on stdin (`-`). */
export function codexArgs(options: CodexArgsOptions): string[] {
  const common = [
    "--json",
    // The checkout is a git repository; this only skips the check for one.
    "--skip-git-repo-check",
    // Only the -c overrides below apply: no config.toml, no execpolicy rules.
    "--ignore-user-config",
    "--ignore-rules",
    ...CONFIG.flatMap((setting) => ["-c", setting]),
    "-c",
    `model_reasoning_effort="${options.reasoningEffort}"`,
    ...(options.model === undefined ? [] : ["-m", options.model]),
    ...(options.outputSchemaPath === undefined
      ? []
      : ["--output-schema", options.outputSchemaPath]),
    "-o",
    options.lastMessagePath,
  ];
  if (options.resumeThreadId !== undefined) {
    // `exec resume` has no --sandbox flag; sandbox_mode above sets it.
    return ["exec", "resume", ...common, options.resumeThreadId, "-"];
  }
  return ["exec", "--sandbox", "read-only", "--color", "never", ...common, "-"];
}

/** Runs the Codex CLI headless (`codex exec`) with a read-only sandbox. */
export class CodexHarness implements Harness {
  readonly id = "codex";
  private readonly options: CodexHarnessOptions;

  constructor(options: CodexHarnessOptions) {
    this.options = options;
  }

  async run<T>(options: HarnessRunOptions<T>): Promise<HarnessResult<T>> {
    const source = this.options.env ?? process.env;
    const auth = codexAuth(source);
    const runId = options.runId ?? randomUUID();
    const deadline = Date.now() + options.timeoutMs;
    const tier = options.tier ?? "standard";
    const model = options.model.trim() || this.options.models?.[tier];
    const home = await mkdtemp(join(this.options.tmpRoot ?? tmpdir(), "lgtmoose-codex-"));
    const codexHome = join(home, ".codex");
    const authPath = join(codexHome, "auth.json");
    const keys: string[] = [];
    const secrets = [...auth.secrets];
    let currentAuth = auth.authJson;
    const execute = async (): Promise<HarnessResult<T>> => {
      await mkdir(codexHome, { recursive: true });
      await mkdir(join(home, "tmp"));
      if (auth.authJson !== undefined) {
        await writeFile(authPath, auth.authJson, { mode: 0o600 });
        await chmod(authPath, 0o600);
      }
      const env: Record<string, string> = {
        PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...networkEnv(source),
        ...auth.env,
        ...hardeningEnv(home, codexHome),
      };
      const schema = schemaFor(options.schema);
      const schemaPath = join(home, "schema.json");
      if (schema.strict !== undefined) await writeFile(schemaPath, JSON.stringify(schema.strict));

      /** Picks up tokens Codex refreshed, so they're redacted and checked for too. */
      const readAuth = async (): Promise<void> => {
        if (auth.authJson === undefined) return;
        const text = await readFile(authPath, "utf8").catch(() => undefined);
        if (text === undefined || text === currentAuth) return;
        currentAuth = text;
        for (const secret of authJsonSecrets(text)) {
          if (!secrets.includes(secret)) secrets.push(secret);
        }
      };

      let threadId: string | undefined;
      const attempt = async (n: number, prompt: string): Promise<Attempt<T>> => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) {
          throw new HarnessError("timeout", `Timed out after ${options.timeoutMs} ms.`, {
            transcriptKeys: keys,
          });
        }
        const lastMessagePath = join(home, `last-${n}.txt`);
        let authErrors = 0;
        const proc = await runProcess({
          command: this.options.binaryPath ?? "codex",
          args: codexArgs({
            ...(model === undefined ? {} : { model }),
            reasoningEffort: CODEX_REASONING_EFFORT[tier],
            ...(schema.strict === undefined ? {} : { outputSchemaPath: schemaPath }),
            lastMessagePath,
            ...(n > 1 && threadId !== undefined ? { resumeThreadId: threadId } : {}),
          }),
          cwd: options.cwd,
          env,
          input: prompt,
          timeoutMs,
          killGraceMs: this.options.killGraceMs ?? 5000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          onLine: (line) => {
            if (isAuthError(line)) authErrors++;
            return authErrors >= MAX_AUTH_ERRORS ? "kill" : undefined;
          },
        });
        await readAuth();
        const key = transcriptKey(runId, n);
        await this.saveTranscript(key, proc, n, secrets, keys);
        const run = parseCodexEvents(proc.stdout);
        threadId = run.threadId ?? threadId;
        failIfUnusable(proc, run, secrets, keys, options.timeoutMs);
        const answer =
          (await readFile(lastMessagePath, "utf8").catch(() => undefined)) ?? run.lastMessage;
        const parsed = parseAnswer(answer);
        if (!parsed.ok) return { kind: "invalid", problems: parsed.error, usage: run.usage, key };
        // Only the strict schema sent to Codex adds nulls for optional fields.
        const value =
          schema.strict === undefined ? parsed.value : dropOptionalNulls(parsed.value, schema.json);
        const checked = options.schema.safeParse(value);
        if (!checked.success) {
          return {
            kind: "invalid",
            problems: z.prettifyError(checked.error),
            usage: run.usage,
            key,
          };
        }
        // A prompt-injected model could try to post the credential in a finding.
        if (valueContainsSecret(checked.data, secrets)) {
          throw new HarnessError("invalid_output", "The output contained a model credential.", {
            transcriptKeys: keys,
          });
        }
        return { kind: "ok", output: checked.data, usage: run.usage, key };
      };

      const first = await attempt(1, options.prompt + schema.promptSuffix);
      if (first.kind === "ok") return success(first, first.usage, keys);
      // Resume the same thread so the model sees its answer; without a thread id (it never
      // started properly) a fresh run with the problems appended is the best there is.
      const repair = repairPrompt(first.problems);
      const second = await attempt(
        2,
        threadId === undefined ? `${options.prompt}${schema.promptSuffix}\n\n${repair}` : repair,
      );
      if (second.kind === "ok") return success(second, addUsage(first.usage, second.usage), keys);
      throw new HarnessError(
        "invalid_output",
        truncate(
          redact(`The output was invalid after a repair retry: ${second.problems}`, secrets),
        ),
        { transcriptKeys: keys },
      );
    };

    let result: HarnessResult<T>;
    try {
      result = await execute();
    } catch (error) {
      // Losing a refreshed token matters, but not more than the run's own failure.
      await this.finish(home, auth.authJson, currentAuth).catch(() => undefined);
      throw error;
    }
    await this.finish(home, auth.authJson, currentAuth);
    return result;
  }

  /** Hands a refreshed `auth.json` back, then removes the run's home whatever happens. */
  private async finish(
    home: string,
    original: string | undefined,
    current: string | undefined,
  ): Promise<void> {
    try {
      await this.handBackAuth(original, current);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  /** Gives the broker a refreshed `auth.json`. Its contents are never logged. */
  private async handBackAuth(original: string | undefined, current: string | undefined) {
    if (original === undefined || current === undefined || current === original) return;
    try {
      JSON.parse(current);
    } catch {
      return; // Half-written by a killed run: keep the old one.
    }
    await this.options.onAuthRefreshed?.(current);
  }

  private async saveTranscript(
    key: string,
    proc: ProcessResult,
    attempt: number,
    secrets: readonly string[],
    keys: string[],
  ): Promise<void> {
    const meta = {
      type: "lgtmoose_harness",
      attempt,
      exit_code: proc.exitCode,
      signal: proc.signal,
      stopped: proc.stopped ?? null,
      stderr: proc.stderr,
    };
    const body = withheldLines(
      redact(`${proc.stdout.replace(/\n?$/, "\n")}${JSON.stringify(meta)}\n`, secrets),
      secrets,
    );
    try {
      await this.options.transcripts.put(key, body);
    } catch (error) {
      throw new HarnessError("transcript", `Could not save transcript ${key}.`, {
        transcriptKeys: keys,
        cause: error,
      });
    }
    keys.push(key);
  }
}

function success<T>(
  attempt: { output: T; key: string },
  usage: HarnessUsage,
  keys: string[],
): HarnessResult<T> {
  const out: HarnessResult<T> = {
    output: attempt.output,
    transcriptKey: attempt.key,
    transcriptKeys: [...keys],
  };
  if (Object.keys(usage).length > 0) out.usage = usage;
  return out;
}

/** An `error` or `turn.failed` event saying the credential was refused. */
function isAuthError(line: string): boolean {
  let event: { type?: unknown; message?: unknown; error?: { message?: unknown } };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return false;
  }
  let message: unknown;
  if (event.type === "error") message = event.message;
  else if (event.type === "turn.failed") message = event.error?.message;
  return typeof message === "string" && classifyFailure(message)?.kind === "auth";
}

/** Throws the right HarnessError when a run didn't complete a turn. */
function failIfUnusable(
  proc: ProcessResult,
  run: CodexRun,
  secrets: readonly string[],
  keys: readonly string[],
  timeoutMs: number,
): void {
  const fail = (
    kind: HarnessError["kind"],
    message: string,
    extra: { retryAfterSeconds?: number; resetsAt?: string } = {},
  ): HarnessError =>
    new HarnessError(kind, truncate(redact(message, secrets)), { transcriptKeys: keys, ...extra });
  if (proc.spawnError) throw fail("process", `Could not start codex: ${proc.spawnError.message}`);
  if (proc.stopped === "timeout") throw fail("timeout", `Timed out after ${timeoutMs} ms.`);
  if (proc.stopped === "requested") throw fail("auth", "The model API rejected the credential.");
  if (proc.stopped === "output_limit")
    throw fail("process", "codex wrote more output than allowed.");
  if (run.completed && run.failure === undefined) return;
  const detail = run.failure ?? (proc.stderr.trim() || "no output");
  const limit = classifyFailure(detail);
  if (limit !== undefined) {
    const { kind, ...extra } = limit;
    throw fail(kind, `codex stopped: ${detail}`, extra);
  }
  throw fail("process", `codex exited (${exitText(proc)}) without finishing: ${detail}`);
}

function exitText(proc: ProcessResult): string {
  if (proc.signal) return `signal ${proc.signal}`;
  return `code ${proc.exitCode ?? "unknown"}`;
}

function truncate(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
}

/**
 * Variables that keep the CLI and git from reading anything but the checkout: a fresh home and
 * CODEX_HOME, and git without user or system config, pager, prompts or lazy fetches.
 */
function hardeningEnv(home: string, codexHome: string): Record<string, string> {
  return {
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: join(home, "tmp"),
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
}

/**
 * How to ask for the schema. An object schema goes to `--output-schema` in OpenAI's strict form
 * (see `strictSchema`); `json` is kept to undo the nulls that form adds. Anything else is
 * described in the prompt.
 */
function schemaFor(schema: z.ZodType): { strict?: unknown; json?: unknown; promptSuffix: string } {
  let json: Record<string, unknown>;
  try {
    json = { ...z.toJSONSchema(schema, { io: "input", target: "draft-7" }) };
    delete json.$schema;
  } catch {
    return { promptSuffix: "\n\nReply with only a JSON value, with no other text." };
  }
  if (json.type === "object") return { strict: strictSchema(json), json, promptSuffix: "" };
  return {
    json,
    promptSuffix: `\n\nReply with only a JSON value that matches this JSON Schema, with no other text:\n${JSON.stringify(json)}`,
  };
}

/** The final message as JSON, also when it's wrapped in a Markdown code fence. */
function parseAnswer(
  answer: string | undefined,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (answer === undefined || answer.trim() === "")
    return { ok: false, error: "There was no answer." };
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(answer);
  try {
    return { ok: true, value: JSON.parse(fenced?.[1] ?? answer) };
  } catch {
    return { ok: false, error: "The answer wasn't valid JSON." };
  }
}

function repairPrompt(problems: string): string {
  return [
    "Your answer did not match the required JSON schema.",
    "",
    "Problems:",
    truncate(problems),
    "",
    "Reply again with only the corrected JSON. Keep everything that was right. Don't explain.",
  ].join("\n");
}
