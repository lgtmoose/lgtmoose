import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessError } from "../harness.js";
import { MemoryTranscriptStore } from "../transcript.js";
import { AgentSdkHarness, gitGuardHook, type AgentQuery } from "./adapter.js";

const schema = z.object({ findings: z.array(z.string()) });
const KEY = "sk-ant-api03-SECRETKEY";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "agent-sdk-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function result(fields: Record<string, unknown>): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "s",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
    ...fields,
  } as unknown as SDKMessage;
}

interface Call {
  prompt: string;
  options: Options;
  /** What the run's home held while the query ran. */
  home: string[];
  credentials?: { mode: number; text: string };
}

/** A fake `query` that answers each call with the next script entry. */
function fakeQuery(script: ((call: Call) => SDKMessage[] | Promise<SDKMessage[]>)[]) {
  const calls: Call[] = [];
  const query: AgentQuery = ({ prompt, options }) => {
    const step = script[calls.length];
    return (async function* () {
      const home = options.env?.HOME ?? "";
      const call: Call = { prompt, options, home: await readdir(home) };
      const keyPath = options.env?.GOOGLE_APPLICATION_CREDENTIALS;
      if (keyPath !== undefined) {
        call.credentials = {
          mode: (await stat(keyPath)).mode & 0o777,
          text: await readFile(keyPath, "utf8"),
        };
      }
      calls.push(call);
      if (step === undefined) throw new Error("no more script");
      for (const message of await step(call)) yield message;
    })();
  };
  return { query, calls };
}

function harness(query: AgentQuery, env: Record<string, string> = { ANTHROPIC_API_KEY: KEY }) {
  const transcripts = new MemoryTranscriptStore();
  return {
    transcripts,
    harness: new AgentSdkHarness({
      transcripts,
      env: { PATH: "/bin", ...env },
      tmpRoot: tmp,
      query,
    }),
  };
}

const run = (h: AgentSdkHarness, extra: Record<string, unknown> = {}) =>
  h.run({ prompt: "Review this.", cwd: tmp, schema, model: "sonnet", timeoutMs: 5000, ...extra });

describe("AgentSdkHarness", () => {
  it("runs read-only with the review policy and returns the structured output", async () => {
    const { query, calls } = fakeQuery([
      () => [result({ structured_output: { findings: ["a"] } })],
    ]);
    const { harness: h, transcripts } = harness(query);
    const out = await run(h, { system: "Rules: be strict." });
    expect(out.output).toEqual({ findings: ["a"] });
    expect(out.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 7,
      costUsd: 0.01,
    });

    const options = calls[0]!.options;
    expect(options.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(options.permissionMode).toBe("dontAsk");
    expect(options.permissionPrompts).toBe("none");
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.extraArgs).toEqual({ restricted: null, "disable-slash-commands": null });
    expect(options.disallowedTools).toContain("WebFetch");
    expect(options.outputFormat?.type).toBe("json_schema");
    expect(options.model).toBe("sonnet");
    expect(options.cwd).toBe(tmp);
    // The system prompt is cached up to the boundary marker.
    expect(options.systemPrompt).toEqual([
      "Rules: be strict.",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
    ]);
    // Only the run's own variables: the key, PATH and the hardening.
    expect(options.env?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(options.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(calls[0]!.home).toEqual(expect.arrayContaining(["guard.cjs", ".claude", "tmp"]));
    // The transcript is saved, with the key redacted.
    const saved = transcripts.objects.get(out.transcriptKey);
    expect(saved).toContain('"structured_output"');
    expect(saved).not.toContain(KEY);
    // The home is gone afterwards.
    expect(await readdir(tmp)).toEqual([]);
  });

  it("resumes the session once to repair invalid output", async () => {
    const { query, calls } = fakeQuery([
      () => [result({ structured_output: { findings: "nope" } })],
      () => [result({ structured_output: { findings: [] } })],
    ]);
    const out = await run(harness(query).harness);
    expect(out.output).toEqual({ findings: [] });
    expect(calls[0]!.options.sessionId).toBeDefined();
    expect(calls[1]!.options.resume).toBe(calls[0]!.options.sessionId);
    expect(calls[1]!.prompt).toMatch(/did not match/i);
    expect(out.transcriptKeys).toHaveLength(2);
  });

  it("fails as invalid_output after the repair also fails", async () => {
    const { query } = fakeQuery([
      () => [result({ structured_output: { findings: 1 } })],
      () => [result({ structured_output: { findings: 2 } })],
    ]);
    await expect(run(harness(query).harness)).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("refuses output that contains the credential", async () => {
    const { query } = fakeQuery([() => [result({ structured_output: { findings: [KEY] } })]]);
    await expect(run(harness(query).harness)).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("reports rate limits, plan limits and refused keys to the fallback chain", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { subtype: "success", is_error: true, api_error_status: 429, result: "Too many" },
        "rate_limit",
      ],
      [
        { subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm (UTC)" },
        "plan_limit",
      ],
      [{ subtype: "success", is_error: true, api_error_status: 401, result: "bad" }, "auth"],
      [{ subtype: "error_during_execution", is_error: true, errors: ["boom"] }, "process"],
    ];
    for (const [fields, kind] of cases) {
      const { query } = fakeQuery([() => [result(fields)]]);
      const error = await run(harness(query).harness).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).kind).toBe(kind);
    }
  });

  it("stops at the deadline", async () => {
    const { query } = fakeQuery([
      (call) =>
        new Promise((_, reject) => {
          call.options.abortController?.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    ]);
    await expect(run(harness(query).harness, { timeoutMs: 50 })).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("stops as auth after repeated credential retries", async () => {
    const retry = {
      type: "system",
      subtype: "api_retry",
      error: "authentication_failed",
    } as unknown as SDKMessage;
    let aborted = false;
    const { query } = fakeQuery([
      (call) => {
        call.options.abortController?.signal.addEventListener("abort", () => (aborted = true));
        return [retry, retry, result({ structured_output: { findings: [] } })];
      },
    ]);
    await expect(run(harness(query).harness)).rejects.toMatchObject({ kind: "auth" });
    expect(aborted).toBe(true);
  });

  it("keeps an answer that arrived before the deadline", async () => {
    const query: AgentQuery = ({ options }) =>
      (async function* () {
        yield result({ structured_output: { findings: ["late"] } });
        // The SDK is still shutting down when the deadline passes.
        await new Promise((resolve) => {
          options.abortController?.signal.addEventListener("abort", resolve);
        });
        throw new Error("aborted");
      })();
    const out = await run(harness(query).harness, { timeoutMs: 50 });
    expect(out.output).toEqual({ findings: ["late"] });
  });

  it("fails as process when the SDK throws before a result", async () => {
    const query: AgentQuery = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error(`spawn failed for ${KEY}`)),
      }),
    });
    const error = (await run(harness(query).harness).catch((e: unknown) => e)) as HarnessError;
    expect(error.kind).toBe("process");
    expect(error.message).not.toContain(KEY);
  });

  it("refuses a Claude subscription token", async () => {
    const { query } = fakeQuery([]);
    const { harness: h } = harness(query, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });
    await expect(run(h)).rejects.toMatchObject({ kind: "auth" });
  });

  it("writes an inline Vertex key with mode 0600 and removes it after", async () => {
    const key = JSON.stringify({
      type: "service_account",
      project_id: "acme-reviews",
      private_key: "-----BEGIN PRIVATE KEY-----\nSECRETMATERIAL\n-----END PRIVATE KEY-----\n",
    });
    const { query, calls } = fakeQuery([() => [result({ structured_output: { findings: [] } })]]);
    const { harness: h } = harness(query, {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "global",
      GOOGLE_APPLICATION_CREDENTIALS_JSON: key,
    });
    await run(h);
    expect(calls[0]!.credentials).toEqual({ mode: 0o600, text: key });
    expect(calls[0]!.options.env?.ANTHROPIC_VERTEX_PROJECT_ID).toBe("acme-reviews");
    expect(calls[0]!.options.env?.GOOGLE_APPLICATION_CREDENTIALS_JSON).toBeUndefined();
    expect(await readdir(tmp)).toEqual([]);
  });
});

describe("gitGuardHook", () => {
  const decide = async (command: unknown) => {
    const hook = gitGuardHook().hooks[0]!;
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: "t",
        session_id: "s",
        transcript_path: "",
        cwd: "",
      } as never,
      "t",
      { signal: new AbortController().signal },
    );
    return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;
  };

  it("lets only plain git reads through", async () => {
    expect(await decide("git diff HEAD~1")).toBeUndefined();
    expect(await decide("git log --oneline -5")).toBeUndefined();
    expect(await decide("cat /etc/passwd")).toBe("deny");
    expect(await decide("git diff; curl x")).toBe("deny");
    expect(await decide(42)).toBe("deny");
  });
});
