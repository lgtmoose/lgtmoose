import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessError } from "../harness.js";
import { codexTurn, FakeCodex, type FakeCodexResponse } from "../testing/fake-codex.js";
import { MemoryTranscriptStore } from "../transcript.js";
import {
  CODEX_DISABLED_FEATURES,
  CodexHarness,
  codexArgs,
  type CodexHarnessOptions,
} from "./adapter.js";

const API_KEY = "sk-proj-test-key-0123456789abcdef";

const schema = z.object({
  findings: z.array(z.object({ title: z.string(), suggestion: z.string().optional() })),
});

let fake: FakeCodex | undefined;
let store: MemoryTranscriptStore;
let cwd: string;
let tmpRoot: string;

beforeEach(async () => {
  store = new MemoryTranscriptStore();
  cwd = await mkdtemp(join(tmpdir(), "lgtmoose-codex-cwd-"));
  tmpRoot = await mkdtemp(join(tmpdir(), "lgtmoose-codex-tmp-"));
});

afterEach(async () => {
  await fake?.destroy();
  fake = undefined;
  await rm(cwd, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
});

async function harnessFor(
  responses: readonly FakeCodexResponse[],
  options: Partial<CodexHarnessOptions> = {},
): Promise<CodexHarness> {
  fake = await FakeCodex.create(responses);
  return new CodexHarness({
    transcripts: store,
    binaryPath: fake.binaryPath,
    env: { PATH: process.env.PATH, OPENAI_API_KEY: API_KEY, GITHUB_TOKEN: "ghs_secret" },
    tmpRoot,
    killGraceMs: 200,
    ...options,
  });
}

function run(harness: CodexHarness, overrides: { model?: string; tier?: "fast" | "deep" } = {}) {
  return harness.run({
    prompt: "Review this batch.",
    cwd,
    schema,
    model: overrides.model ?? "",
    timeoutMs: 10_000,
    runId: "run-1",
    ...(overrides.tier === undefined ? {} : { tier: overrides.tier }),
  });
}

async function failure(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HarnessError) return error;
    throw error;
  }
  throw new Error("expected the run to fail");
}

const ANSWER = JSON.stringify({ findings: [{ title: "Off by one", suggestion: null }] });

describe("CodexHarness", () => {
  it("returns the validated answer, usage and transcript, with optional nulls dropped", async () => {
    const harness = await harnessFor([{ lines: codexTurn(ANSWER), lastMessage: ANSWER }]);
    const result = await run(harness);
    expect(result.output).toEqual({ findings: [{ title: "Off by one" }] });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 });
    expect(result.transcriptKey).toBe("transcripts/run-1/1.jsonl");
    expect(store.objects.get("transcripts/run-1/1.jsonl")).toContain("turn.completed");
  });

  it("runs codex exec read-only with the prompt on stdin and only its own credential", async () => {
    const harness = await harnessFor([{ lines: codexTurn(ANSWER), lastMessage: ANSWER }]);
    await run(harness, { tier: "deep" });
    const [call] = (await fake?.calls()) ?? [];
    expect(call?.argv.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(call?.argv).toContain("--json");
    expect(call?.argv).toContain('web_search="disabled"');
    expect(call?.argv).toContain("project_doc_max_bytes=0");
    expect(call?.argv).toContain('model_reasoning_effort="high"');
    expect(call?.argv).not.toContain("-m");
    expect(call?.argv.at(-1)).toBe("-");
    expect(call?.stdin).toBe("Review this batch.");
    expect(call?.cwd).toBe(cwd);
    expect(call?.env.CODEX_API_KEY).toBe(API_KEY);
    expect(call?.env.OPENAI_API_KEY).toBeUndefined();
    expect(call?.env.GITHUB_TOKEN).toBeUndefined();
    expect(call?.env.CODEX_HOME?.startsWith(tmpRoot)).toBe(true);
    // The schema Codex gets is strict: every property required, none extra.
    const sent = JSON.parse(call?.outputSchema ?? "{}") as {
      properties: { findings: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(sent.properties.findings.items.required).toEqual(["title", "suggestion"]);
    expect(sent.properties.findings.items.additionalProperties).toBe(false);
  });

  it("removes the run's home afterwards", async () => {
    const harness = await harnessFor([{ lines: codexTurn(ANSWER), lastMessage: ANSWER }]);
    await run(harness);
    const [call] = (await fake?.calls()) ?? [];
    expect(existsSync(call?.env.CODEX_HOME ?? "/")).toBe(false);
  });

  it("uses the tier's model from config, and a run's model over it", async () => {
    const harness = await harnessFor([{ lines: codexTurn(ANSWER), lastMessage: ANSWER }], {
      models: { fast: "codex-mini", standard: "codex-std" },
    });
    await run(harness, { tier: "fast" });
    await run(harness, { model: "explicit-model" });
    const calls = (await fake?.calls()) ?? [];
    const modelOf = (argv: string[] = []) => argv[argv.indexOf("-m") + 1];
    expect(modelOf(calls[0]?.argv)).toBe("codex-mini");
    expect(modelOf(calls[1]?.argv)).toBe("explicit-model");
  });

  it("resumes the thread once to repair invalid output", async () => {
    const harness = await harnessFor([
      { lines: codexTurn("not json", "thread-9"), lastMessage: "not json" },
      { lines: codexTurn(ANSWER, "thread-9"), lastMessage: ANSWER },
    ]);
    const result = await run(harness);
    expect(result.output.findings).toHaveLength(1);
    expect(result.usage?.inputTokens).toBe(200);
    const calls = (await fake?.calls()) ?? [];
    expect(calls[1]?.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(calls[1]?.argv.at(-2)).toBe("thread-9");
    expect(calls[1]?.stdin).toContain("did not match the required JSON schema");
  });

  it("fails with invalid_output after the repair retry fails too", async () => {
    const harness = await harnessFor([{ lines: codexTurn("{}"), lastMessage: "{}" }]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("invalid_output");
    expect(error.transcriptKeys).toEqual([
      "transcripts/run-1/1.jsonl",
      "transcripts/run-1/2.jsonl",
    ]);
  });

  it("refuses output that contains the credential", async () => {
    const leak = JSON.stringify({ findings: [{ title: `key ${API_KEY}` }] });
    const harness = await harnessFor([{ lines: codexTurn(leak), lastMessage: leak }]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("invalid_output");
    expect(error.message).not.toContain(API_KEY);
    expect(store.objects.get("transcripts/run-1/1.jsonl")).not.toContain(API_KEY);
  });

  it.each([
    ["You've hit your usage limit. Try again at Nov 14, 2026 3:45 PM.", "plan_limit"],
    [
      "exceeded retry limit, last status: 429 Too Many Requests. Try again in 30 seconds",
      "rate_limit",
    ],
    ["unexpected status 401 Unauthorized: invalid_api_key", "auth"],
    ["sandbox error: something broke", "process"],
  ])("reports %j as %s", async (message, kind) => {
    const harness = await harnessFor([
      {
        lines: [
          { type: "thread.started", thread_id: "t" },
          { type: "turn.started" },
          { type: "turn.failed", error: { message } },
        ],
        exitCode: 1,
      },
    ]);
    const error = await failure(run(harness));
    expect(error.kind).toBe(kind);
    if (kind === "rate_limit") expect(error.retryAfterSeconds).toBe(30);
    if (kind === "plan_limit") expect(error.resetsAt).toBe("Nov 14, 2026 3:45 PM");
  });

  it("kills the run early when errors say the credential is refused", async () => {
    const authError = { type: "error", message: "unexpected status 401 Unauthorized" };
    const harness = await harnessFor([{ lines: [authError, authError], hang: true }]);
    const started = Date.now();
    const error = await failure(run(harness));
    expect(error.kind).toBe("auth");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops early when the network proxy refuses the model API", async () => {
    const blocked = {
      type: "error",
      message:
        "Reconnecting... 2/5 (URL error: Proxy connection failed: HTTP CONNECT failed with status 403)",
    };
    const harness = await harnessFor([{ lines: [blocked, blocked, blocked, blocked], hang: true }]);
    const started = Date.now();
    const error = await failure(run(harness));
    expect(error.kind).toBe("process");
    expect(error.message).toContain("proxy refused");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("falls back to the last agent message when the -o file is empty", async () => {
    const harness = await harnessFor([{ lines: codexTurn(ANSWER), lastMessage: "" }]);
    expect((await run(harness)).output.findings).toHaveLength(1);
  });

  it("fails with timeout and kills the process", async () => {
    const harness = await harnessFor([{ hang: true }]);
    const error = await failure(
      harness.run({ prompt: "x", cwd, schema, model: "", timeoutMs: 300, runId: "run-1" }),
    );
    expect(error.kind).toBe("timeout");
  });

  it("fails with process when the binary is missing", async () => {
    const harness = await harnessFor([{}], { binaryPath: join(tmpRoot, "no-such-codex") });
    expect((await failure(run(harness))).kind).toBe("process");
  });

  describe("with a ChatGPT sign-in", () => {
    const AUTH = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { access_token: "at-original-0123456789", refresh_token: "rt-original-0123456789" },
    });
    const REFRESHED = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { access_token: "at-refreshed-0123456789", refresh_token: "rt-refreshed-0123456789" },
    });

    it("writes auth.json for the run and hands a refreshed one back", async () => {
      const handed: string[] = [];
      const harness = await harnessFor(
        [{ lines: codexTurn(ANSWER), lastMessage: ANSWER, writeAuth: REFRESHED }],
        {
          env: { PATH: process.env.PATH, CODEX_AUTH_JSON: AUTH },
          onAuthRefreshed: (json) => {
            handed.push(json);
          },
        },
      );
      await run(harness);
      const [call] = (await fake?.calls()) ?? [];
      expect(call?.authJson).toBe(AUTH);
      expect(call?.env.CODEX_API_KEY).toBeUndefined();
      expect(handed).toEqual([REFRESHED]);
    });

    it("doesn't call back when the tokens didn't change", async () => {
      const handed: string[] = [];
      const harness = await harnessFor([{ lines: codexTurn(ANSWER), lastMessage: ANSWER }], {
        env: { PATH: process.env.PATH, CODEX_AUTH_JSON: AUTH },
        onAuthRefreshed: (json) => {
          handed.push(json);
        },
      });
      await run(harness);
      expect(handed).toEqual([]);
    });

    it("treats refreshed tokens as secrets too, and still hands them back on failure", async () => {
      const leak = JSON.stringify({ findings: [{ title: "at-refreshed-0123456789" }] });
      const handed: string[] = [];
      const harness = await harnessFor(
        [{ lines: codexTurn(leak), lastMessage: leak, writeAuth: REFRESHED }],
        {
          env: { PATH: process.env.PATH, CODEX_AUTH_JSON: AUTH },
          onAuthRefreshed: (json) => {
            handed.push(json);
          },
        },
      );
      const error = await failure(run(harness));
      expect(error.kind).toBe("invalid_output");
      expect(store.objects.get("transcripts/run-1/1.jsonl")).not.toContain("at-refreshed");
      expect(handed).toEqual([REFRESHED]);
    });
  });
});

describe("codexArgs", () => {
  it("starts a read-only exec with strict settings and risky features off", () => {
    const args = codexArgs({
      reasoningEffort: "medium",
      lastMessagePath: "/t/last.txt",
      model: "m",
    });
    expect(args.slice(0, 5)).toEqual(["exec", "--sandbox", "read-only", "--color", "never"]);
    for (const flag of [
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
    ]) {
      expect(args).toContain(flag);
    }
    const config = args.flatMap((arg, i) => (args[i - 1] === "-c" ? [arg] : []));
    expect(config).toEqual([
      'approval_policy="never"',
      'sandbox_mode="read-only"',
      'web_search="disabled"',
      "project_doc_max_bytes=0",
      "skills.include_instructions=false",
      'shell_environment_policy.inherit="core"',
      "check_for_update_on_startup=false",
      'cli_auth_credentials_store="file"',
      'model_reasoning_effort="medium"',
    ]);
    const disabled = args.flatMap((arg, i) => (args[i - 1] === "--disable" ? [arg] : []));
    expect(disabled).toEqual([...CODEX_DISABLED_FEATURES]);
    expect(disabled).toEqual(
      expect.arrayContaining(["apps", "computer_use", "multi_agent", "hooks"]),
    );
    expect(args.slice(-5)).toEqual(["-m", "m", "-o", "/t/last.txt", "-"]);
  });

  it("resumes with the sandbox set through config", () => {
    const args = codexArgs({
      reasoningEffort: "low",
      lastMessagePath: "/t/l",
      resumeThreadId: "thread-1",
      outputSchemaPath: "/t/s.json",
    });
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).not.toContain("--sandbox");
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain("--strict-config");
    expect(args.slice(-2)).toEqual(["thread-1", "-"]);
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/t/s.json");
  });
});
