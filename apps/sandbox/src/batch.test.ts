import {
  HarnessError,
  type Harness,
  type HarnessRunOptions,
  type TranscriptStore,
} from "@lgtmoose/harness";
import { batchTranscriptKeys } from "@lgtmoose/pipeline";
import { describe, expect, it } from "vitest";
import { runSandboxBatch, type SandboxDeps } from "./batch.js";
import { credentialEnv, harnessEnv } from "./credential.js";

const RUN_ID = "0b6f6d8e-3c1a-4c3e-9a51-6f1f0e0c2a11";
const BASE = "https://bucket.s3.eu-west-1.amazonaws.com/runs";
const [TRANSCRIPT = ""] = batchTranscriptKeys(RUN_ID, 1);

const FINDING = {
  rule_category: "correctness",
  severity: "blocking",
  path: "src/total.ts",
  line: 3,
  side: "RIGHT",
  title: "Loop skips the last item",
  body: "The bound drops the last item.",
  evidence: "for (;;) {",
};

interface Setup {
  run?: "ok" | "timeout";
  status?: number;
  input?: object;
  /** What removing escaping symlinks finds. */
  links?: string[];
}

function setup(options: Setup = {}) {
  const puts = new Map<string, string>();
  const runs: HarnessRunOptions<unknown>[] = [];
  const extracted: string[] = [];
  const dropped: string[] = [];
  const downloaded: Uint8Array[] = [];
  const objects: Record<string, unknown> = {
    "/runs/urls.json": {
      checkout: `${BASE}/checkout.tar.gz?X-Amz-Signature=s`,
      input: `${BASE}/input.json?X-Amz-Signature=s`,
      output: `${BASE}/output.json?X-Amz-Signature=s`,
      transcripts: { [TRANSCRIPT]: `${BASE}/t1.jsonl?X-Amz-Signature=s` },
    },
    "/runs/input.json": options.input ?? {
      version: 1,
      runId: RUN_ID,
      index: 1,
      prompt: "Review src/total.ts",
      model: "sonnet",
      timeoutMs: 60_000,
    },
  };
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "PUT") {
      puts.set(path, typeof init.body === "string" ? init.body : "");
      return new Response(null, { status: 200 });
    }
    if (options.status !== undefined) return new Response("denied", { status: options.status });
    if (path === "/runs/checkout.tar.gz") return new Response(new Uint8Array([1, 2, 3]));
    return Response.json(objects[path]);
  }) as typeof fetch;
  const harness = (transcripts: TranscriptStore): Harness => ({
    id: "fake",
    run: async <T>(run: HarnessRunOptions<T>) => {
      runs.push(run as HarnessRunOptions<unknown>);
      await transcripts.put(TRANSCRIPT, "{}\n");
      await transcripts.put("transcripts/other/9.jsonl", "{}\n");
      if (options.run === "timeout") {
        throw new HarnessError("timeout", "The run timed out.", { transcriptKeys: [TRANSCRIPT] });
      }
      return {
        output: run.schema.parse({ findings: [FINDING] }),
        transcriptKey: TRANSCRIPT,
        usage: { costUsd: 0.5 },
      };
    },
  });
  const logs: string[] = [];
  const deps: SandboxDeps = {
    fetch: fakeFetch,
    writeFile: async (_path, body) => {
      downloaded.push(new Uint8Array(await new Response(body).arrayBuffer()));
    },
    extract: async (_archive, dir) => {
      extracted.push(dir);
    },
    dropEscapingSymlinks: async (dir) => {
      // Only after the checkout is there, and before the harness runs.
      if (!extracted.includes(dir) || runs.length > 0) throw new Error("out of order");
      dropped.push(dir);
      return options.links ?? [];
    },
    harness,
    workDir: "/work",
    log: (message, fields) => logs.push(`${message} ${JSON.stringify(fields ?? {})}`),
  };
  return { deps, puts, runs, extracted, dropped, downloaded, logs };
}

describe("runSandboxBatch", () => {
  it("runs the batch on the extracted checkout and writes the output and transcripts", async () => {
    const s = setup();
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);

    expect(s.downloaded).toEqual([new Uint8Array([1, 2, 3])]);
    expect(s.extracted).toEqual(["/work/checkout"]);
    expect(s.runs[0]).toMatchObject({
      cwd: "/work/checkout",
      model: "sonnet",
      prompt: "Review src/total.ts",
      runId: `${RUN_ID}-batch-1`,
    });
    expect(output).toMatchObject({ version: 1, index: 1, transcriptKeys: [TRANSCRIPT] });
    expect(JSON.parse(s.puts.get("/runs/output.json") ?? "")).toEqual(output);
    expect(s.puts.get("/runs/t1.jsonl")).toBe("{}\n");
    // A transcript with no URL is dropped, not written anywhere.
    expect(s.puts.size).toBe(2);
  });

  it("removes escaping symlinks after extracting and before the harness runs", async () => {
    const s = setup({ links: ["docs/env"] });
    await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.dropped).toEqual(["/work/checkout"]);
    expect(s.runs).toHaveLength(1);
    expect(
      s.logs.some((line) => line.includes("removed symlinks") && line.includes("docs/env")),
    ).toBe(true);
  });

  it("writes a model failure as the batch's error", async () => {
    const s = setup({ run: "timeout" });
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);

    expect(output.findings).toBeUndefined();
    expect(output.error).toContain("timed out");
    expect(JSON.parse(s.puts.get("/runs/output.json") ?? "")).toEqual(output);
  });

  it("fails the task, without the signature, when a URL is refused", async () => {
    const s = setup({ status: 403 });
    const error = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=secret`).then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e : undefined),
    );
    expect(error?.message).toContain("HTTP 403");
    expect(error?.message).not.toContain("secret");
    expect(s.puts.size).toBe(0);
  });

  it("rejects an input that doesn't match its schema", async () => {
    const s = setup({ input: { version: 2 } });
    await expect(runSandboxBatch(s.deps, `${BASE}/urls.json`)).rejects.toThrow();
    expect(s.runs).toEqual([]);
  });
});

describe("credentialEnv", () => {
  it("names the credential for each supported harness and auth", () => {
    expect(credentialEnv("claude-code", "oauth-token", "t")).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "t",
    });
    expect(credentialEnv("claude-code", "api-key", " k ")).toEqual({ ANTHROPIC_API_KEY: "k" });
    expect(credentialEnv("claude-code", "bedrock", undefined)).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(credentialEnv("codex", "chatgpt-login", "{}")).toEqual({ CODEX_AUTH_JSON: "{}" });
    expect(credentialEnv("codex", "access-token", "a")).toEqual({ CODEX_ACCESS_TOKEN: "a" });
    expect(credentialEnv("codex", "api-key", "k")).toEqual({ CODEX_API_KEY: "k" });
    expect(credentialEnv("cursor-agent", "api-key", "k")).toEqual({ CURSOR_API_KEY: "k" });
    expect(credentialEnv("cursor-agent", "service-account", "k")).toEqual({
      CURSOR_API_KEY: "k",
    });
  });

  it("refuses a missing credential and unsupported providers, without the value", () => {
    expect(() => credentialEnv("claude-code", "api-key", " ")).toThrow("isn't set");
    for (const [harness, auth] of [
      ["claude-code", "vertex"],
      ["agent-sdk", "api-key"],
    ] as const) {
      const error = (() => {
        try {
          credentialEnv(harness, auth, "secret-value");
        } catch (e) {
          return String(e);
        }
        return "";
      })();
      expect(error).toContain("can't run");
      expect(error).not.toContain("secret-value");
    }
  });
});

describe("harnessEnv", () => {
  it("passes the proxy and the credential, not the task's other variables", () => {
    expect(
      harnessEnv(
        {
          PATH: "/bin",
          HTTPS_PROXY: "http://proxy:3128",
          LGTMOOSE_PROVIDER_CREDENTIAL: "secret",
          LGTMOOSE_BATCH_URLS: "https://x",
        },
        { ANTHROPIC_API_KEY: "secret" },
      ),
    ).toEqual({ PATH: "/bin", HTTPS_PROXY: "http://proxy:3128", ANTHROPIC_API_KEY: "secret" });
  });
});
