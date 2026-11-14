import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessError } from "../harness.js";
import { cursorResult, FakeCursor, type FakeCursorResponse } from "../testing/fake-cursor.js";
import { MemoryTranscriptStore } from "../transcript.js";
import {
  CursorHarness,
  cursorArgs,
  MAX_CURSOR_PROMPT_BYTES,
  type CursorHarnessOptions,
} from "./adapter.js";
import { CURSOR_PERMISSIONS, cursorPermissions } from "./policy.js";

const API_KEY = "key_cursor_test_0123456789abcdef";

const schema = z.object({
  findings: z.array(z.object({ title: z.string(), suggestion: z.string().optional() })),
});

let fake: FakeCursor | undefined;
let store: MemoryTranscriptStore;
let cwd: string;
let tmpRoot: string;

beforeEach(async () => {
  store = new MemoryTranscriptStore();
  cwd = await mkdtemp(join(tmpdir(), "lgtmoose-cursor-cwd-"));
  tmpRoot = await mkdtemp(join(tmpdir(), "lgtmoose-cursor-tmp-"));
});

afterEach(async () => {
  await fake?.destroy();
  fake = undefined;
  await rm(cwd, { recursive: true, force: true });
  await rm(tmpRoot, { recursive: true, force: true });
});

async function harnessFor(
  responses: readonly FakeCursorResponse[],
  options: Partial<CursorHarnessOptions> = {},
): Promise<CursorHarness> {
  fake = await FakeCursor.create(responses);
  return new CursorHarness({
    transcripts: store,
    binaryPath: fake.binaryPath,
    env: {
      PATH: process.env.PATH,
      CURSOR_API_KEY: API_KEY,
      GITHUB_TOKEN: "ghs_secret",
      HTTPS_PROXY: "http://proxy:3128",
    },
    tmpRoot,
    killGraceMs: 200,
    ...options,
  });
}

function run(
  harness: CursorHarness,
  overrides: { model?: string; tier?: "fast" | "deep"; prompt?: string; timeoutMs?: number } = {},
) {
  return harness.run({
    prompt: overrides.prompt ?? "Review this batch.",
    cwd,
    schema,
    model: overrides.model ?? "",
    timeoutMs: overrides.timeoutMs ?? 10_000,
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

const ANSWER = JSON.stringify({ findings: [{ title: "Off by one" }] });

describe("cursorArgs", () => {
  it("runs print mode in read-only ask mode, never with --force or MCP approval", () => {
    const args = cursorArgs({ model: "sonnet-4.5", prompt: "-p looks like a flag" });
    expect(args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--mode",
      "ask",
      "--trust",
      "--sandbox",
      "enabled",
      "--model",
      "sonnet-4.5",
      "--",
      "-p looks like a flag",
    ]);
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--approve-mcps");
  });

  it("resumes a chat for the repair retry", () => {
    expect(cursorArgs({ resumeSessionId: "chat-1", prompt: "fix" }).slice(-4)).toEqual([
      "--resume",
      "chat-1",
      "--",
      "fix",
    ]);
  });
});

describe("CursorHarness", () => {
  it("returns validated output, usage and the transcript", async () => {
    const harness = await harnessFor([{ stdout: cursorResult(ANSWER) }]);
    const result = await run(harness);
    expect(result.output).toEqual({ findings: [{ title: "Off by one" }] });
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
    });
    expect(result.transcriptKey).toBe("transcripts/run-1/1.jsonl");
    expect(store.objects.get("transcripts/run-1/1.jsonl")).toContain('"type":"lgtmoose_harness"');
  });

  it("passes only the key, PATH, proxy and hardening variables, in a fresh home", async () => {
    const harness = await harnessFor([{ stdout: cursorResult(ANSWER) }]);
    await run(harness);
    const [call] = await fake!.calls();
    expect(call?.env.CURSOR_API_KEY).toBe(API_KEY);
    expect(call?.env.HTTPS_PROXY).toBe("http://proxy:3128");
    expect(call?.env.GITHUB_TOKEN).toBeUndefined();
    expect(call?.env.HOME?.startsWith(tmpRoot)).toBe(true);
    expect(call?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(call?.cwd).toBe(cwd);
    expect(call?.argv.join(" ")).not.toContain(API_KEY);
    // The run's home is removed afterwards.
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("writes the deny-everything-but-reads permissions as the global config", async () => {
    const harness = await harnessFor([{ stdout: cursorResult(ANSWER) }]);
    await run(harness);
    const [call] = await fake!.calls();
    const config = JSON.parse(call?.cliConfig ?? "{}") as { permissions?: unknown };
    expect(config.permissions).toEqual(cursorPermissions(cwd));
    expect(CURSOR_PERMISSIONS.deny).toEqual(
      expect.arrayContaining(["Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"]),
    );
  });

  it("denies reads outside the checkout, but never of the checkout itself", () => {
    const sandbox = cursorPermissions("/work/repo").deny;
    // The CLI's own environment holds the key; its home and temp dirs hold its state.
    expect(sandbox).toEqual(
      expect.arrayContaining(["Read(/proc/**)", "Read(/tmp/**)", "Read(/home/**)", "Read(~/**)"]),
    );
    const laptop = cursorPermissions("/home/dev/src/../repo").deny;
    expect(laptop).toContain("Read(/proc/**)");
    expect(laptop).not.toContain("Read(/home/**)");
    expect(cursorPermissions("/tmp/x").deny).not.toContain("Read(/tmp/**)");
    // A sibling whose name only starts the same is still denied.
    expect(cursorPermissions("/homework").deny).toContain("Read(/home/**)");
  });

  it("sets the checkout's hook configs aside for the run and puts them back", async () => {
    await mkdir(join(cwd, ".cursor"));
    await mkdir(join(cwd, ".claude"));
    await writeFile(join(cwd, ".cursor", "hooks.json"), '{"hooks":{}}');
    await writeFile(join(cwd, ".cursor", "cli.json"), "{}");
    await writeFile(join(cwd, ".claude", "settings.json"), "{}");
    const harness = await harnessFor([{ stdout: cursorResult(ANSWER) }]);
    await run(harness);
    const [call] = await fake!.calls();
    expect(call?.projectCursorDir).toHaveLength(2);
    expect(call?.projectCursorDir).toContain("cli.json");
    expect(call?.projectCursorDir).not.toContain("hooks.json");
    expect(await readFile(join(cwd, ".cursor", "hooks.json"), "utf8")).toBe('{"hooks":{}}');
    expect((await readdir(join(cwd, ".cursor"))).sort()).toEqual(["cli.json", "hooks.json"]);
    expect(await readdir(join(cwd, ".claude"))).toEqual(["settings.json"]);
  });

  it("puts the hook configs back after a failed run too", async () => {
    await mkdir(join(cwd, ".cursor"));
    await writeFile(join(cwd, ".cursor", "hooks.json"), "{}");
    const harness = await harnessFor([{ stderr: "boom", exitCode: 1 }]);
    await failure(run(harness));
    expect(await readdir(join(cwd, ".cursor"))).toEqual(["hooks.json"]);
  });

  it("describes the schema in the prompt, the last argument", async () => {
    const harness = await harnessFor([{ stdout: cursorResult(ANSWER) }]);
    await run(harness);
    const [call] = await fake!.calls();
    const prompt = call?.argv.at(-1) ?? "";
    expect(call?.argv.at(-2)).toBe("--");
    expect(prompt.startsWith("Review this batch.")).toBe(true);
    expect(prompt).toContain('"findings"');
  });

  it("maps the tier to a model, and a run's model wins", async () => {
    const models = { fast: "gpt-5-mini", deep: "opus-4.5" };
    let harness = await harnessFor([{ stdout: cursorResult(ANSWER) }], { models });
    await run(harness, { tier: "deep" });
    expect((await fake!.calls())[0]?.argv).toContain("opus-4.5");
    await fake!.destroy();

    harness = await harnessFor([{ stdout: cursorResult(ANSWER) }], { models });
    await run(harness, { tier: "fast", model: "sonnet-4.5" });
    const argv = (await fake!.calls())[0]?.argv ?? [];
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet-4.5");
    await fake!.destroy();

    harness = await harnessFor([{ stdout: cursorResult(ANSWER) }]);
    await run(harness);
    expect((await fake!.calls())[0]?.argv).not.toContain("--model");
  });

  it("repairs invalid output once, resuming the chat", async () => {
    const harness = await harnessFor([
      { stdout: cursorResult('{"findings": [{"name": 1}]}', "chat-9") },
      { stdout: cursorResult(`\`\`\`json\n${ANSWER}\n\`\`\``, "chat-9") },
    ]);
    const result = await run(harness);
    expect(result.output.findings[0]?.title).toBe("Off by one");
    expect(result.transcriptKeys).toEqual([
      "transcripts/run-1/1.jsonl",
      "transcripts/run-1/2.jsonl",
    ]);
    expect(result.usage?.inputTokens).toBe(200);
    const calls = await fake!.calls();
    expect(calls[1]?.argv).toContain("--resume");
    expect(calls[1]?.argv).toContain("chat-9");
    expect(calls[1]?.argv.at(-1)).toContain("did not match the required JSON schema");
  });

  it("fails with invalid_output after the repair retry also fails", async () => {
    const harness = await harnessFor([{ stdout: cursorResult("not json") }]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("invalid_output");
    expect(error.transcriptKeys).toHaveLength(2);
  });

  it("refuses output that contains the key", async () => {
    const leak = JSON.stringify({ findings: [{ title: `key ${API_KEY}` }] });
    const harness = await harnessFor([{ stdout: cursorResult(leak) }]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("invalid_output");
    expect(error.message).not.toContain(API_KEY);
  });

  it("redacts the key from transcripts and errors", async () => {
    const harness = await harnessFor([
      { stderr: `Error: invalid api key ${API_KEY}`, exitCode: 1 },
    ]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("auth");
    expect(error.message).not.toContain(API_KEY);
    expect(store.objects.get("transcripts/run-1/1.jsonl")).not.toContain(API_KEY);
  });

  it.each([
    ["You've hit your usage limit. Upgrade to Pro for more.", "plan_limit"],
    ["Error: rate limit exceeded, try again in 30 seconds", "rate_limit"],
    ["Authentication required. Run agent login or set CURSOR_API_KEY.", "auth"],
  ] as const)("classifies %j as %s for the fallback chain", async (stderr, kind) => {
    const harness = await harnessFor([{ stderr, exitCode: 1 }]);
    const error = await failure(run(harness));
    expect(error.kind).toBe(kind);
    if (kind === "rate_limit") expect(error.retryAfterSeconds).toBe(30);
  });

  it("classifies an error result's text even with a warning on stderr", async () => {
    const stdout = `${JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "You've hit your usage limit",
    })}\n`;
    const harness = await harnessFor([
      { stdout, stderr: "warning: update available", exitCode: 1 },
    ]);
    expect((await failure(run(harness))).kind).toBe("plan_limit");
  });

  it("treats an error result as a failure", async () => {
    const stdout = `${JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Too many requests",
    })}\n`;
    const harness = await harnessFor([{ stdout, exitCode: 1 }]);
    expect((await failure(run(harness))).kind).toBe("rate_limit");
  });

  it("reports other failures as process errors", async () => {
    const harness = await harnessFor([{ stderr: "segfault", exitCode: 139 }]);
    const error = await failure(run(harness));
    expect(error.kind).toBe("process");
    expect(error.message).toContain("segfault");
  });

  it("fails without a key before starting the CLI", async () => {
    const harness = await harnessFor([{ stdout: cursorResult(ANSWER) }], {
      env: { PATH: process.env.PATH },
    });
    expect((await failure(run(harness))).kind).toBe("auth");
    expect(await fake!.calls()).toEqual([]);
  });

  it("refuses a prompt too long for one argument", async () => {
    const harness = await harnessFor([{ stdout: cursorResult(ANSWER) }]);
    const error = await failure(run(harness, { prompt: "x".repeat(MAX_CURSOR_PROMPT_BYTES) }));
    expect(error.kind).toBe("process");
    expect(await fake!.calls()).toEqual([]);
  });

  it("repeats a near-limit prompt for a fresh-start repair", async () => {
    const harness = await harnessFor([
      // No session id, and enough problems to fill the repair text.
      {
        stdout: `${JSON.stringify({
          type: "result",
          subtype: "success",
          result: JSON.stringify({ findings: Array.from({ length: 60 }, () => ({ name: 1 })) }),
        })}\n`,
      },
      { stdout: cursorResult(ANSWER) },
    ]);
    const prompt = "x".repeat(MAX_CURSOR_PROMPT_BYTES - 1000);
    const result = await run(harness, { prompt });
    expect(result.output.findings).toHaveLength(1);
    const calls = await fake!.calls();
    expect(calls[1]?.argv).not.toContain("--resume");
    expect(calls[1]?.argv.at(-1)?.startsWith(prompt)).toBe(true);
  });

  it("kills a hung run at the deadline", async () => {
    const harness = await harnessFor([{ hang: true }]);
    const error = await failure(run(harness, { timeoutMs: 300 }));
    expect(error.kind).toBe("timeout");
    expect(existsSync(tmpRoot) && (await readdir(tmpRoot)).length === 0).toBe(true);
  });

  it("reports a missing binary as a process error", async () => {
    const harness = await harnessFor([{ stdout: "" }], { binaryPath: join(cwd, "no-agent") });
    expect((await failure(run(harness))).kind).toBe("process");
  });
});
