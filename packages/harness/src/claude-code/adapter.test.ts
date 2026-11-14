import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessError } from "../harness.js";
import { FakeClaude, resultLine, waitGone, type FakeResponse } from "../testing/fake-claude.js";
import { MemoryTranscriptStore, type TranscriptStore } from "../transcript.js";
import { ClaudeCodeHarness, type ClaudeCodeHarnessOptions } from "./adapter.js";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS } from "./policy.js";

const API_KEY = "sk-ant-api03-test-key-0123456789";
const schema = z.object({
  findings: z.array(z.object({ path: z.string(), line: z.number().int(), message: z.string() })),
});
const finding = { path: "src/a.ts", line: 3, message: "Off by one." };

let fake: FakeClaude | undefined;
let cwd: string;
let store: MemoryTranscriptStore;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "lgtmoose-harness-cwd-"));
  store = new MemoryTranscriptStore();
});
afterEach(async () => {
  await fake?.destroy();
  fake = undefined;
  await rm(cwd, { recursive: true, force: true });
});

async function harnessFor(
  responses: FakeResponse[],
  options: Partial<ClaudeCodeHarnessOptions> = {},
): Promise<ClaudeCodeHarness> {
  fake = await FakeClaude.create(responses);
  return new ClaudeCodeHarness({
    transcripts: store,
    binaryPath: fake.binaryPath,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: API_KEY, GITHUB_TOKEN: "ghs_not_for_you" },
    killGraceMs: 200,
    ...options,
  });
}

function run<T>(harness: ClaudeCodeHarness, overrides: { schema?: z.ZodType<T> } = {}) {
  return harness.run({
    prompt: "Review the batch.",
    cwd,
    schema: overrides.schema ?? (schema as unknown as z.ZodType<T>),
    model: "sonnet",
    timeoutMs: 10_000,
    runId: "run-1",
  });
}

async function failure(promise: Promise<unknown>): Promise<HarnessError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HarnessError);
  return error as HarnessError;
}

function flagValues(argv: string[], flag: string): string[] {
  const start = argv.indexOf(flag);
  if (start < 0) return [];
  const values: string[] = [];
  for (const arg of argv.slice(start + 1)) {
    if (arg.startsWith("--")) break;
    values.push(arg);
  }
  return values;
}

describe("ClaudeCodeHarness", () => {
  it("returns the validated structured output, usage and transcript key", async () => {
    const harness = await harnessFor([
      {
        lines: [
          { type: "system", subtype: "init", tools: ["Read"] },
          resultLine({ structured_output: { findings: [finding] } }),
        ],
      },
    ]);
    const result = await run(harness);
    expect(harness.id).toBe("claude-code");
    expect(result.output).toEqual({ findings: [finding] });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      costUsd: 0.25,
    });
    expect(result.transcriptKey).toBe("transcripts/run-1/1.jsonl");
    expect(result.transcriptKeys).toEqual(["transcripts/run-1/1.jsonl"]);
    const transcript = store.objects.get("transcripts/run-1/1.jsonl") ?? "";
    expect(transcript).toContain('"subtype":"init"');
    expect(transcript).toContain('"type":"lgtmoose_harness"');
  });

  it("runs claude -p in the checkout with read-only tools, the prompt on stdin", async () => {
    const harness = await harnessFor([
      { lines: [resultLine({ structured_output: { findings: [] } })] },
    ]);
    await run(harness);
    const [call] = await (fake as FakeClaude).calls();
    if (!call) throw new Error("claude wasn't called");
    const argv = call.argv;
    expect(call.stdin).toBe("Review the batch.");
    expect(call.cwd).toBe(cwd);
    expect(argv[0]).toBe("-p");
    expect(flagValues(argv, "--output-format")).toEqual(["stream-json"]);
    expect(argv).toContain("--verbose");
    expect(argv).toContain("--restricted");
    expect(flagValues(argv, "--model")).toEqual(["sonnet"]);
    expect(flagValues(argv, "--tools")).toEqual(["Read,Grep,Glob,Bash"]);
    expect(flagValues(argv, "--allowedTools")).toEqual(ALLOWED_TOOLS);
    expect(flagValues(argv, "--disallowedTools")).toEqual(DISALLOWED_TOOLS);
    expect(flagValues(argv, "--permission-mode")).toEqual(["dontAsk"]);
    expect(flagValues(argv, "--permission-prompts")).toEqual(["none"]);
    expect(argv).toContain("--strict-mcp-config");
    expect(flagValues(argv, "--mcp-config")).toEqual(['{"mcpServers":{}}']);
    expect(argv).toContain("--disable-slash-commands");
    expect(flagValues(argv, "--session-id")[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(argv).not.toContain("--resume");

    const jsonSchema = JSON.parse(flagValues(argv, "--json-schema")[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.$schema).toBeUndefined();
    expect(jsonSchema.required).toEqual(["findings"]);

    const settings = JSON.parse(flagValues(argv, "--settings")[0] ?? "{}") as {
      permissions: {
        allow: string[];
        deny: string[];
        blockReadsOutsideWorkingDirectories: boolean;
      };
      hooks: { PreToolUse: { matcher: string }[] };
    };
    expect(settings.permissions.allow).toEqual(ALLOWED_TOOLS);
    expect(settings.permissions.deny).toEqual(DISALLOWED_TOOLS);
    expect(settings.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(settings.hooks.PreToolUse[0]?.matcher).toBe("Bash");
  });

  it("gives the CLI only the credential and settings it needs, in a home it removes", async () => {
    const harness = await harnessFor([
      { lines: [resultLine({ structured_output: { findings: [] } })] },
    ]);
    await run(harness);
    const [call] = await (fake as FakeClaude).calls();
    if (!call) throw new Error("claude wasn't called");
    const env = call.env;
    expect(env.ANTHROPIC_API_KEY).toBe(API_KEY);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.HOME).toMatch(/lgtmoose-claude-/);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(env.HOME ?? "", ".claude"));
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("0");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(existsSync(env.HOME ?? "/nonexistent")).toBe(false);
    const allowed = new Set([
      "PATH",
      "ANTHROPIC_API_KEY",
      "HOME",
      "CLAUDE_CONFIG_DIR",
      "TMPDIR",
      "PWD",
      "SHLVL",
      "_",
    ]);
    const extra = Object.keys(env).filter(
      (name) =>
        !allowed.has(name) &&
        !name.startsWith("CLAUDE_CODE_") &&
        !name.startsWith("DISABLE_") &&
        !name.startsWith("GIT_") &&
        name !== "PAGER",
    );
    expect(extra).toEqual([]);
  });

  it("can turn on the subprocess environment scrub", async () => {
    const harness = await harnessFor(
      [{ lines: [resultLine({ structured_output: { findings: [] } })] }],
      { scrubSubprocessEnv: true, maxTurns: 40 },
    );
    await run(harness);
    const [call] = await (fake as FakeClaude).calls();
    expect(call?.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(flagValues(call?.argv ?? [], "--max-turns")).toEqual(["40"]);
  });

  it("asks in the prompt when the schema isn't an object, and parses a fenced answer", async () => {
    const harness = await harnessFor([
      { lines: [resultLine({ result: '```json\n["a", "b"]\n```' })] },
    ]);
    const result = await run(harness, { schema: z.array(z.string()) });
    expect(result.output).toEqual(["a", "b"]);
    const [call] = await (fake as FakeClaude).calls();
    expect(call?.argv).not.toContain("--json-schema");
    expect(call?.stdin).toContain("Reply with only a JSON value that matches this JSON Schema");
  });

  it("makes one repair retry in the same session, with the validation errors", async () => {
    const harness = await harnessFor([
      { lines: [resultLine({ structured_output: { findings: [{ path: "a.ts", line: 1.5 }] } })] },
      // Claude Code restores the session's cost on resume: 0.40 includes the first 0.25.
      { lines: [resultLine({ structured_output: { findings: [finding] }, total_cost_usd: 0.4 })] },
    ]);
    const result = await run(harness);
    expect(result.output).toEqual({ findings: [finding] });
    expect(result.transcriptKey).toBe("transcripts/run-1/2.jsonl");
    expect(result.transcriptKeys).toEqual([
      "transcripts/run-1/1.jsonl",
      "transcripts/run-1/2.jsonl",
    ]);
    expect(result.usage?.inputTokens).toBe(200);
    expect(result.usage?.costUsd).toBe(0.4);

    const [first, second] = await (fake as FakeClaude).calls();
    const sessionId = flagValues(first?.argv ?? [], "--session-id")[0];
    expect(flagValues(second?.argv ?? [], "--resume")).toEqual([sessionId]);
    expect(second?.argv).not.toContain("--session-id");
    expect(second?.stdin).toContain("did not match the required JSON schema");
    expect(second?.stdin).toContain("findings[0].line");
    expect(second?.stdin).toContain("findings[0].message");
  });

  it("repairs when the CLI ran out of structured output retries", async () => {
    const harness = await harnessFor([
      { lines: [resultLine({ subtype: "error_max_structured_output_retries", is_error: true })] },
      { lines: [resultLine({ structured_output: { findings: [] } })] },
    ]);
    expect((await run(harness)).output).toEqual({ findings: [] });
  });

  it("fails with invalid_output after the repair retry fails too", async () => {
    const harness = await harnessFor([
      { lines: [resultLine({ structured_output: { findings: "none" } })] },
    ]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("invalid_output");
    expect(error.message).toContain("findings");
    expect(error.transcriptKeys).toEqual([
      "transcripts/run-1/1.jsonl",
      "transcripts/run-1/2.jsonl",
    ]);
    expect(await (fake as FakeClaude).calls()).toHaveLength(2);
  });

  it("fails with invalid_output when the text answer isn't JSON, twice", async () => {
    const harness = await harnessFor([{ lines: [resultLine({ result: "Looks good to me!" })] }]);
    const error = await failure(run(harness, { schema: z.array(z.string()) }));
    expect(error.kind).toBe("invalid_output");
    const [, second] = await (fake as FakeClaude).calls();
    expect(second?.stdin).toContain("wasn't valid JSON");
  });

  it("refuses output that contains the credential, without a retry", async () => {
    const harness = await harnessFor([
      {
        lines: [
          resultLine({
            structured_output: { findings: [{ ...finding, message: `key is ${API_KEY}` }] },
          }),
        ],
      },
    ]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("invalid_output");
    expect(error.message).not.toContain(API_KEY);
    expect(await (fake as FakeClaude).calls()).toHaveLength(1);
    expect(store.objects.get("transcripts/run-1/1.jsonl")).not.toContain(API_KEY);
  });

  it("refuses output with the credential split over lines", async () => {
    const split = `${API_KEY.slice(0, 8)}\n${API_KEY.slice(8)}`;
    const harness = await harnessFor([
      {
        lines: [resultLine({ structured_output: { findings: [{ ...finding, message: split }] } })],
      },
    ]);
    expect((await failure(run(harness))).kind).toBe("invalid_output");
    const transcript = store.objects.get("transcripts/run-1/1.jsonl") ?? "";
    expect(transcript).toContain("lgtmoose_withheld");
    expect(transcript).not.toContain(API_KEY.slice(8));
  });

  it("withholds a cut-off transcript line that holds a split credential", async () => {
    // A killed run can leave half a stream-json line: not JSON, with the key split by `\n`.
    const partial = `{"type":"assistant","message":"${API_KEY.slice(0, 8)}\\n${API_KEY.slice(8)}`;
    const harness = await harnessFor([
      { lines: [resultLine({ structured_output: { findings: [] } })], stdout: partial },
    ]);
    await run(harness).catch(() => undefined);
    const transcript = store.objects.get("transcripts/run-1/1.jsonl") ?? "";
    expect(transcript).toContain("lgtmoose_withheld");
    expect(transcript).not.toContain(API_KEY.slice(8));
  });

  it("redacts the credential from transcripts and errors", async () => {
    const harness = await harnessFor([
      {
        lines: [{ type: "assistant", text: `I found ${API_KEY}` }],
        stderr: `fatal: bad key ${API_KEY}`,
        exitCode: 1,
      },
    ]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("process");
    expect(error.message).toContain("fatal: bad key ***");
    expect(error.message).not.toContain(API_KEY);
    const transcript = store.objects.get("transcripts/run-1/1.jsonl") ?? "";
    expect(transcript).toContain("I found ***");
    expect(transcript).not.toContain(API_KEY);
  });

  it("kills the whole process tree on timeout", async () => {
    const harness = await harnessFor([{ grandchild: true, hang: true }]);
    const started = Date.now();
    const error = await failure(
      harness.run({ prompt: "p", cwd, schema, model: "sonnet", timeoutMs: 500, runId: "slow" }),
    );
    expect(error.kind).toBe("timeout");
    // SIGTERM is ignored, so this waited for the SIGKILL after the grace period.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await waitGone((fake as FakeClaude).pid("child"))).toBe(true);
    expect(await waitGone((fake as FakeClaude).pid("grandchild"))).toBe(true);
    expect(error.transcriptKeys).toEqual(["transcripts/slow/1.jsonl"]);
    expect(store.objects.get("transcripts/slow/1.jsonl")).toContain('"stopped":"timeout"');
  });

  it("kills processes the CLI leaves behind when it exits", async () => {
    const harness = await harnessFor([
      { grandchild: true, lines: [resultLine({ structured_output: { findings: [] } })] },
    ]);
    await run(harness);
    expect(await waitGone((fake as FakeClaude).pid("grandchild"))).toBe(true);
  });

  it("fails with auth before starting the CLI when there's no credential", async () => {
    const harness = await harnessFor([{}], { env: { PATH: process.env.PATH } });
    const error = await failure(run(harness));
    expect(error.kind).toBe("auth");
    expect(await (fake as FakeClaude).calls()).toHaveLength(0);
  });

  it("stops early with auth when the API keeps rejecting the credential", async () => {
    const retry = {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      error: "authentication_failed",
    };
    const harness = await harnessFor([{ lines: [retry, retry], hang: true }]);
    const started = Date.now();
    const error = await failure(run(harness));
    expect(error.kind).toBe("auth");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("fails with auth when the result reports HTTP 401", async () => {
    const harness = await harnessFor([
      {
        lines: [resultLine({ subtype: "success", is_error: true, api_error_status: 401 })],
        exitCode: 1,
      },
    ]);
    expect((await failure(run(harness))).kind).toBe("auth");
  });

  it("fails with process when the CLI reports an error", async () => {
    const harness = await harnessFor([
      {
        lines: [resultLine({ subtype: "error_max_turns", is_error: true, result: "Out of turns" })],
        exitCode: 1,
      },
    ]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("process");
    expect(error.message).toContain("error_max_turns");
  });

  it("fails with process when the binary is missing", async () => {
    const harness = await harnessFor([{}], { binaryPath: join(cwd, "no-such-claude") });
    const error = await failure(run(harness));
    expect(error.kind).toBe("process");
    expect(error.message).toContain("Could not start claude");
  });

  it("fails with transcript when the transcript can't be saved", async () => {
    const broken: TranscriptStore = { put: () => Promise.reject(new Error("S3 is down")) };
    const harness = await harnessFor(
      [{ lines: [resultLine({ structured_output: { findings: [] } })] }],
      { transcripts: broken },
    );
    const error = await failure(run(harness));
    expect(error.kind).toBe("transcript");
    expect(error.transcriptKeys).toEqual([]);
  });

  it("uses a random run id when none is given", async () => {
    const harness = await harnessFor([
      { lines: [resultLine({ structured_output: { findings: [] } })] },
    ]);
    const result = await harness.run({ prompt: "p", cwd, schema, model: "m", timeoutMs: 10_000 });
    expect(result.transcriptKey).toMatch(/^transcripts\/[0-9a-f-]{36}\/1\.jsonl$/);
  });
});
