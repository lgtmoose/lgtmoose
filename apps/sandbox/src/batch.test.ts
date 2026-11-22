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
  /** What removing symlinks finds. */
  links?: string[];
  /** A credential the harness refreshed during the run. */
  refreshed?: string;
  /** Whether the batch has a URL to hand a refreshed credential back. */
  credentialUrl?: boolean;
  /** The reviewer's notes for the cross-file pass. */
  notes?: string[];
  /** What the model returns instead of a finding (a judgement, for a judge batch). */
  output?: unknown;
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
      ...(options.credentialUrl === true
        ? { credential: `${BASE}/credential.json?X-Amz-Signature=s` }
        : {}),
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
  const harness = (
    transcripts: TranscriptStore,
    onAuthRefreshed: (credential: string) => Promise<void>,
  ): Harness => ({
    id: "fake",
    run: async <T>(run: HarnessRunOptions<T>) => {
      runs.push(run as HarnessRunOptions<unknown>);
      if (options.refreshed !== undefined) await onAuthRefreshed(options.refreshed);
      await transcripts.put(TRANSCRIPT, "{}\n");
      await transcripts.put("transcripts/other/9.jsonl", "{}\n");
      if (options.run === "timeout") {
        throw new HarnessError("timeout", "The run timed out.", { transcriptKeys: [TRANSCRIPT] });
      }
      return {
        output: run.schema.parse(
          options.output ?? {
            findings: [FINDING],
            ...(options.notes === undefined ? {} : { notes: options.notes }),
          },
        ),
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
    dropSymlinks: async (dir) => {
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

  it("runs its own provider's model, sends the shared part as system, and keeps notes", async () => {
    const s = setup({
      input: {
        version: 1,
        runId: RUN_ID,
        index: 1,
        prompt: "Review src/total.ts",
        system: "# Role\n\nShared rules.",
        model: "sonnet",
        timeoutMs: 60_000,
      },
      notes: ["exports total()", "exports total()", "x".repeat(900)],
    });
    s.deps.model = "gpt-5.1-codex";
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.runs[0]).toMatchObject({
      model: "gpt-5.1-codex",
      system: "# Role\n\nShared rules.",
      prompt: "Review src/total.ts",
    });
    expect(output.notes).toEqual(["exports total()", `${"x".repeat(499)}…`]);
  });

  it("runs the reply judge on the fast tier for a judge batch", async () => {
    const s = setup({
      input: {
        version: 1,
        runId: RUN_ID,
        index: 4,
        prompt: "Judge this reply",
        role: "judge",
        tier: "fast",
        model: "sonnet",
        timeoutMs: 60_000,
      },
      output: { kind: "fixed", fixed_at_head: false, line: 3, text: "Still off by one." },
    });
    s.deps.model = "sonnet";
    s.deps.fastModel = "haiku";
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.runs[0]).toMatchObject({ model: "haiku", tier: "fast", prompt: "Judge this reply" });
    expect(s.runs[0]?.system).toBeUndefined();
    expect(output).toMatchObject({
      index: 4,
      judgement: { kind: "fixed", fixed_at_head: false, line: 3 },
    });
    expect(output.findings).toBeUndefined();
    expect(JSON.parse(s.puts.get("/runs/output.json") ?? "")).toEqual(output);
  });

  it("runs a recheck batch on the fast model, and writes its verdicts", async () => {
    const s = setup({
      input: {
        version: 1,
        runId: RUN_ID,
        index: 7,
        prompt: "Check these findings again",
        role: "recheck",
        tier: "fast",
        model: "sonnet",
        timeoutMs: 60_000,
      },
      output: {
        verdicts: [
          { id: "F1", confirmed: false, reason: "src/pay.ts line 9 maps the saved card." },
        ],
      },
    });
    s.deps.model = "sonnet";
    s.deps.fastModel = "haiku";
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.runs[0]).toMatchObject({ model: "haiku", tier: "fast" });
    expect(s.runs[0]?.system).toBeUndefined();
    expect(output).toMatchObject({ index: 7, verdicts: [{ id: "F1", confirmed: false }] });
    expect(output.findings).toBeUndefined();
    expect(JSON.parse(s.puts.get("/runs/output.json") ?? "")).toEqual(output);
  });

  it("runs a ticket batch on the fast model with no system, and writes its checklist", async () => {
    const s = setup({
      input: {
        version: 1,
        runId: RUN_ID,
        index: 5,
        prompt: "Check this ticket",
        role: "ticket",
        tier: "fast",
        model: "sonnet",
        timeoutMs: 60_000,
      },
      output: {
        requirements: [{ text: "Round to cents", core: true, status: "missing" }],
      },
    });
    s.deps.model = "sonnet";
    s.deps.fastModel = "haiku";
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.runs[0]).toMatchObject({ model: "haiku", tier: "fast", prompt: "Check this ticket" });
    expect(s.runs[0]?.system).toBeUndefined();
    expect(output).toMatchObject({
      index: 5,
      coverage: { requirements: [{ text: "Round to cents", core: true, status: "missing" }] },
    });
    expect(output.findings).toBeUndefined();
    expect(output.judgement).toBeUndefined();
    expect(JSON.parse(s.puts.get("/runs/output.json") ?? "")).toEqual(output);
  });

  it("runs an explain batch on the fast model, and writes its answer", async () => {
    const s = setup({
      input: {
        version: 1,
        runId: RUN_ID,
        index: 6,
        prompt: "Explain this finding",
        role: "explain",
        tier: "fast",
        model: "sonnet",
        timeoutMs: 60_000,
      },
      output: { text: "The catch drops the error.", line: 4 },
    });
    s.deps.model = "sonnet";
    s.deps.fastModel = "haiku";
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.runs[0]).toMatchObject({
      model: "haiku",
      tier: "fast",
      prompt: "Explain this finding",
    });
    expect(s.runs[0]?.system).toBeUndefined();
    expect(output).toMatchObject({
      index: 6,
      explanation: { text: "The catch drops the error.", line: 4 },
    });
    expect(output.findings).toBeUndefined();
    expect(JSON.parse(s.puts.get("/runs/output.json") ?? "")).toEqual(output);
  });

  it("runs a bootstrap batch on the fast model, and writes its candidates", async () => {
    const candidates = [
      { kind: "convention", text: "Use the query builder, not raw SQL.", sources: ["c1", "c4"] },
    ];
    const s = setup({
      input: {
        version: 1,
        runId: RUN_ID,
        index: 0,
        prompt: "Distil these comments",
        role: "bootstrap",
        tier: "fast",
        model: "sonnet",
        timeoutMs: 60_000,
      },
      output: { candidates },
    });
    s.deps.model = "sonnet";
    s.deps.fastModel = "haiku";
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.runs[0]).toMatchObject({ model: "haiku", tier: "fast" });
    expect(s.runs[0]?.system).toBeUndefined();
    expect(output).toMatchObject({ index: 0, candidates });
    expect(output.findings).toBeUndefined();
    expect(JSON.parse(s.puts.get("/runs/output.json") ?? "")).toEqual(output);
  });

  it("writes a judge's failure as the batch's error", async () => {
    const s = setup({
      run: "timeout",
      input: {
        version: 1,
        runId: RUN_ID,
        index: 4,
        prompt: "Judge this reply",
        role: "judge",
        tier: "fast",
        model: "",
        timeoutMs: 60_000,
      },
    });
    const output = await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(output.judgement).toBeUndefined();
    expect(output.error).toMatch(/^timeout:/);
  });

  it("removes symlinks after extracting and before the harness runs", async () => {
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

  it("hands a refreshed credential back to its URL, never to the log", async () => {
    const s = setup({ refreshed: '{"tokens":{"refresh_token":"r2"}}', credentialUrl: true });
    await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.puts.get("/runs/credential.json")).toBe('{"tokens":{"refresh_token":"r2"}}');
    expect(s.logs.join("\n")).not.toContain("r2");
  });

  it("drops a refreshed credential when there's no URL for it", async () => {
    const s = setup({ refreshed: '{"tokens":{"refresh_token":"r2"}}' });
    await runSandboxBatch(s.deps, `${BASE}/urls.json?X-Amz-Signature=s`);
    expect(s.puts.has("/runs/credential.json")).toBe(false);
    expect(s.logs.some((line) => line.includes("nowhere to hand it back"))).toBe(true);
    expect(s.logs.join("\n")).not.toContain("r2");
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
    expect(credentialEnv("agent-sdk", "api-key", "k")).toEqual({ ANTHROPIC_API_KEY: "k" });
    expect(credentialEnv("agent-sdk", "bedrock", undefined)).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    for (const harness of ["claude-code", "agent-sdk"]) {
      expect(credentialEnv(harness, "vertex", '{"type":"service_account"}')).toEqual({
        CLAUDE_CODE_USE_VERTEX: "1",
        GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
      });
    }
  });

  it("refuses a missing credential and unsupported providers, without the value", () => {
    expect(() => credentialEnv("claude-code", "api-key", " ")).toThrow("isn't set");
    for (const [harness, auth] of [
      ["claude-code", "chatgpt-login"],
      ["agent-sdk", "oauth-token"],
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

  it("passes the task's model pins and Vertex settings", () => {
    expect(
      harnessEnv(
        {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          CLOUD_ML_REGION: "global",
          ANTHROPIC_VERTEX_PROJECT_ID: "acme",
          GOOGLE_APPLICATION_CREDENTIALS: "/elsewhere.json",
        },
        {},
      ),
    ).toEqual({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      CLOUD_ML_REGION: "global",
      ANTHROPIC_VERTEX_PROJECT_ID: "acme",
    });
  });
});
