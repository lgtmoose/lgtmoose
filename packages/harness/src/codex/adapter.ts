import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type ModelTier,
} from "../harness.js";
import { exitText, saveAttemptTranscript, success } from "../attempt.js";
import { parseAnswer, repairPrompt, schemaJson, schemaPromptSuffix, truncate } from "../answer.js";
import { isolatedEnv, networkEnv } from "../env.js";
import { addUsage } from "../usage.js";
import { runProcess, type ProcessResult } from "../process.js";
import { redact, valueContainsSecret } from "../redact.js";
import { transcriptKey, type TranscriptStore } from "../transcript.js";
import { authJsonSecrets, codexAuth } from "./auth.js";
import { dropOptionalNulls, strictSchema } from "./schema.js";
import { classifyFailure, classifyReportedFailure } from "../limits.js";
import { parseCodexEvents, type CodexRun } from "./stream.js";

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
/**
 * A proxy that refuses the model API's host (an egress allowlist without it) won't change its
 * mind: stop after this many refusals instead of reconnecting until the timeout.
 */
const MAX_BLOCKED_CONNECTS = 4;
const BLOCKED_CONNECT = /Proxy connection failed|HTTP CONNECT failed/;

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
  // Skills in the checkout (.agents/skills) are PR content too.
  "skills.include_instructions=false",
  'shell_environment_policy.inherit="core"',
  "check_for_update_on_startup=false",
  'cli_auth_credentials_store="file"',
];

/**
 * Features Codex 0.166 turns on by default that a read-only reviewer must not have: connectors,
 * browsers and computer use, image generation, sub-agents, hooks, plugins and skill installs,
 * tool suggestions, worktrees and background daemons. Also `unbounded_connection_retries`, so a
 * blocked network fails instead of retrying until the timeout.
 */
export const CODEX_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "in_app_local_automation",
  "multi_agent",
  "hooks",
  "plugins",
  "remote_plugin",
  "plugin_discovery_prefetch",
  "plugin_sharing",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "workspace_dependencies",
  "worktrees",
  "daemon_auto_start",
  "goals",
  "realtime_conversation",
  "unbounded_connection_retries",
] as const;

/** The command line. The prompt goes on stdin (`-`). */
export function codexArgs(options: CodexArgsOptions): string[] {
  const common = [
    "--json",
    // The checkout is a git repository; this only skips the check for one.
    "--skip-git-repo-check",
    // Only the -c overrides below apply: no config.toml, no execpolicy rules. An override
    // this version doesn't know is an error rather than silently ignored.
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    ...CONFIG.flatMap((setting) => ["-c", setting]),
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
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
        let blockedConnects = 0;
        let stopReason: "auth" | "blocked" | undefined;
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
          secrets,
          onLine: (line) => {
            if (isAuthError(line)) authErrors++;
            if (BLOCKED_CONNECT.test(line)) blockedConnects++;
            if (authErrors >= MAX_AUTH_ERRORS) stopReason = "auth";
            else if (blockedConnects >= MAX_BLOCKED_CONNECTS) stopReason = "blocked";
            return stopReason === undefined ? undefined : "kill";
          },
        });
        await readAuth();
        const key = transcriptKey(runId, n);
        await saveAttemptTranscript(this.options.transcripts, key, proc, n, secrets, keys);
        const run = parseCodexEvents(proc.stdout);
        threadId = run.threadId ?? threadId;
        failIfUnusable(proc, run, secrets, keys, options.timeoutMs, stopReason);
        const written = await readFile(lastMessagePath, "utf8").catch(() => "");
        const answer = written.trim() === "" ? run.lastMessage : written;
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

      const first = await attempt(1, fullPrompt(options) + schema.promptSuffix);
      if (first.kind === "ok") return success(first, first.usage, keys);
      // Resume the same thread so the model sees its answer; without a thread id (it never
      // started properly) a fresh run with the problems appended is the best there is.
      const repair = repairPrompt(first.problems);
      const second = await attempt(
        2,
        threadId === undefined
          ? `${fullPrompt(options)}${schema.promptSuffix}\n\n${repair}`
          : repair,
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
      // The run's own failure is what's thrown, but a refreshed token that couldn't be handed
      // back is recorded on it: a rotated refresh token may be lost.
      try {
        await this.finish(home, auth.authJson, currentAuth);
      } catch (handBackError) {
        throw withHandBackError(error, handBackError);
      }
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
  stopReason?: "auth" | "blocked",
): void {
  const fail = (
    kind: HarnessError["kind"],
    message: string,
    extra: { retryAfterSeconds?: number; resetsAt?: string } = {},
  ): HarnessError =>
    new HarnessError(kind, truncate(redact(message, secrets)), { transcriptKeys: keys, ...extra });
  if (proc.spawnError) throw fail("process", `Could not start codex: ${proc.spawnError.message}`);
  if (proc.stopped === "timeout") throw fail("timeout", `Timed out after ${timeoutMs} ms.`);
  if (proc.stopped === "requested" && stopReason === "blocked") {
    throw fail("process", "The network proxy refused the connection to the model API.");
  }
  if (proc.stopped === "requested") throw fail("auth", "The model API rejected the credential.");
  if (proc.stopped === "output_limit")
    throw fail("process", "codex wrote more output than allowed.");
  if (run.completed && run.failure === undefined) return;
  const detail = run.failure || proc.stderr.trim() || "no output";
  // Wording only in Codex's own failure event; stderr for machine signals, without a failure
  // event or behind a generic one, as for Cursor.
  const limit = classifyReportedFailure(run.failure, proc.stderr, classifyFailure);
  if (limit !== undefined) {
    const { kind, ...extra } = limit;
    throw fail(kind, `codex stopped: ${detail}`, extra);
  }
  throw fail("process", `codex exited (${exitText(proc)}) without finishing: ${detail}`);
}

/** `isolatedEnv`, plus CODEX_HOME and no colour. */
function hardeningEnv(home: string, codexHome: string): Record<string, string> {
  return { ...isolatedEnv(home), CODEX_HOME: codexHome, NO_COLOR: "1" };
}

/**
 * How to ask for the schema. An object schema goes to `--output-schema` in OpenAI's strict form
 * (see `strictSchema`); `json` is kept to undo the nulls that form adds. Anything else is
 * described in the prompt.
 */
function schemaFor(schema: z.ZodType): { strict?: unknown; json?: unknown; promptSuffix: string } {
  const json = schemaJson(schema);
  if (json === undefined) return { promptSuffix: schemaPromptSuffix(undefined) };
  if (json.type === "object") return { strict: strictSchema(json), json, promptSuffix: "" };
  return { json, promptSuffix: schemaPromptSuffix(json) };
}

/** The run's error, marked with why the refreshed credential couldn't be handed back. */
function withHandBackError(error: unknown, handBackError: unknown): HarnessError {
  if (error instanceof HarnessError) {
    return new HarnessError(error.kind, error.message, {
      transcriptKeys: error.transcriptKeys,
      cause: error.cause,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.resetsAt === undefined ? {} : { resetsAt: error.resetsAt }),
      authHandBackError: handBackError,
    });
  }
  return new HarnessError("process", error instanceof Error ? error.message : String(error), {
    cause: error,
    authHandBackError: handBackError,
  });
}
