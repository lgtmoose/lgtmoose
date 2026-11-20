import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "@lgtmoose/core";
import { HarnessError, type Harness, type HarnessRunOptions } from "@lgtmoose/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixtures } from "./fixture.js";
import {
  assignmentFromRoles,
  assignmentsFromProviders,
  limitHits,
  matrixAssignments,
  matrixRan,
  matrixResultsSchema,
  modelsFrom,
  renderMatrixMarkdown,
  runMatrix,
  type MatrixResults,
} from "./matrix.js";
import { EVAL_PROVIDERS, type EvalProvider } from "./providers.js";
import type { FixtureScore } from "./score.js";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

const OFF_BY_ONE: Finding = {
  rule_category: "correctness",
  severity: "blocking",
  path: "src/cart.ts",
  line: 10,
  side: "RIGHT",
  title: "Loop skips the last item",
  body: "The bound drops the last item.",
  evidence: "for (let i = 0; i < items.length - 1; i++) {",
};

/** A provider whose harness answers as `answer` says, with no real model behind it. */
function fakeProvider(
  id: string,
  answer: (options: HarnessRunOptions<unknown>) => Finding[],
  unavailable?: string,
): EvalProvider & { models: string[] } {
  const models: string[] = [];
  return {
    id,
    description: `fake ${id}`,
    defaultModel: `${id}-default`,
    unavailable: () => unavailable,
    models,
    create: (): Harness => ({
      id,
      run: async <T>(options: HarnessRunOptions<T>) => {
        models.push(options.model);
        return {
          output: options.schema.parse({ findings: answer(options as HarnessRunOptions<unknown>) }),
          transcriptKey: "t",
          usage: { costUsd: 0.25 },
        };
      },
    }),
  };
}

describe("matrix flags", () => {
  it("takes --providers as the reviewer on each provider, each once", () => {
    expect(assignmentsFromProviders("claude, chatgpt,claude,", EVAL_PROVIDERS)).toEqual([
      { label: "reviewer=claude", roles: { reviewer: "claude" } },
      { label: "reviewer=chatgpt", roles: { reviewer: "chatgpt" } },
    ]);
    expect(() => assignmentsFromProviders("claude,gemini", EVAL_PROVIDERS)).toThrow(
      /Unknown provider "gemini"/,
    );
    expect(() => assignmentsFromProviders(" , ", EVAL_PROVIDERS)).toThrow(/at least one/);
  });

  it("takes --roles as role=provider pairs, and refuses roles the pipeline doesn't run", () => {
    expect(assignmentFromRoles("reviewer=cursor", EVAL_PROVIDERS)).toEqual({
      label: "reviewer=cursor",
      roles: { reviewer: "cursor" },
    });
    expect(() => assignmentFromRoles("reviewer=claude,verifier=chatgpt", EVAL_PROVIDERS)).toThrow(
      /doesn't run the verifier role yet/,
    );
    expect(() => assignmentFromRoles("judge=claude", EVAL_PROVIDERS)).toThrow(/Unknown role/);
    expect(() => assignmentFromRoles("reviewer", EVAL_PROVIDERS)).toThrow(/role=provider/);
    expect(() => assignmentFromRoles("reviewer=claude,reviewer=cursor", EVAL_PROVIDERS)).toThrow(
      /twice/,
    );
    expect(() => assignmentFromRoles("reviewer=nope", EVAL_PROVIDERS)).toThrow(/Unknown provider/);
  });

  it("merges --providers and --roles without repeating a configuration", () => {
    const all = matrixAssignments(
      { providers: "claude,cursor", roles: ["reviewer=cursor", "reviewer=chatgpt"] },
      EVAL_PROVIDERS,
    );
    expect(all.map((entry) => entry.label)).toEqual([
      "reviewer=claude",
      "reviewer=cursor",
      "reviewer=chatgpt",
    ]);
  });

  it("reads --model per provider, with a bare name for claude", () => {
    expect(modelsFrom(["opus", "chatgpt=gpt-5-codex", "cursor = auto"])).toEqual({
      claude: "opus",
      chatgpt: "gpt-5-codex",
      cursor: "auto",
    });
    expect(modelsFrom(undefined)).toEqual({});
  });
});

describe("built-in providers", () => {
  it("say why they can't run without a credential, and never fail for it", () => {
    for (const provider of Object.values(EVAL_PROVIDERS)) {
      expect(provider.unavailable({})).toMatch(/credential|Set /);
    }
    expect(EVAL_PROVIDERS.claude?.unavailable({ ANTHROPIC_API_KEY: "k" })).toBeUndefined();
    expect(EVAL_PROVIDERS.chatgpt?.unavailable({ OPENAI_API_KEY: "k" })).toBeUndefined();
    expect(EVAL_PROVIDERS.cursor?.unavailable({ CURSOR_API_KEY: "k" })).toBeUndefined();
    expect(EVAL_PROVIDERS["agent-sdk"]?.unavailable({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toMatch(
      /not CLAUDE_CODE_OAUTH_TOKEN/,
    );
    expect(EVAL_PROVIDERS["agent-sdk"]?.unavailable({ ANTHROPIC_API_KEY: "k" })).toBeUndefined();
  });
});

describe("limit hits", () => {
  it("counts batch failures that were a rate or plan limit", () => {
    const score = (errors: string[], repeatErrors: string[] = []) =>
      ({ errors, repeatErrors }) as unknown as FixtureScore;
    expect(
      limitHits([
        score(["batch 1: plan_limit: Usage limit reached.", "batch 2: timeout: too slow"]),
        score(["batch 1: rate_limit: Slow down."]),
        score([]),
        score([], ["batch 1: plan_limit: Usage limit reached."]),
      ]),
    ).toBe(3);
  });
});

describe("running the matrix", () => {
  let workRoot: string;
  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), "lgtmoose-matrix-test-"));
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it("runs the same fixtures on each provider, skips one without a credential, and counts limit hits", async () => {
    const fixtures = (await loadFixtures(FIXTURES)).filter((f) =>
      ["off-by-one", "clean-rename"].includes(f.name),
    );
    const good = fakeProvider("good", (options) =>
      options.prompt.includes('path="src/cart.ts"') ? [OFF_BY_ONE] : [],
    );
    const quiet = fakeProvider("quiet", () => []);
    const limited: EvalProvider = {
      ...fakeProvider("limited", () => []),
      create: () => ({
        id: "limited",
        run: async () => {
          throw new HarnessError("plan_limit", "Usage limit reached.");
        },
      }),
    };
    const absent = fakeProvider("absent", () => [], "No credential found.");
    const providers = { good, quiet, limited, absent };
    const assignments = matrixAssignments({ providers: "good,quiet,limited,absent" }, providers);
    const reported: string[] = [];
    const results = await runMatrix(fixtures, assignments, {
      providers,
      env: {},
      harnessFor: (provider) => provider.create({ transcripts: undefined as never, env: {} }),
      models: { good: "big" },
      batchTimeoutMs: 1000,
      workRoot,
      onReport: async (assignment) => {
        reported.push(assignment.label);
      },
    });

    expect(() => matrixResultsSchema.parse(results)).not.toThrow();
    expect(results.fixtures).toEqual(fixtures.map((f) => f.name));
    const byLabel = Object.fromEntries(results.configurations.map((c) => [c.label, c]));
    expect(byLabel["reviewer=good"]).toMatchObject({
      status: "ran",
      models: { reviewer: "big" },
      totals: { recall: 1, falsePositiveRate: 0, limitHits: 0, failedRuns: 0 },
    });
    expect(good.models.every((model) => model === "big")).toBe(true);
    expect(byLabel["reviewer=quiet"]).toMatchObject({
      status: "ran",
      models: { reviewer: "quiet-default" },
      totals: { recall: 0, limitHits: 0 },
    });
    expect(byLabel["reviewer=limited"]).toMatchObject({
      status: "ran",
      totals: { recall: 0, limitHits: 2, failedRuns: 2 },
    });
    expect(byLabel["reviewer=absent"]).toEqual({
      label: "reviewer=absent",
      roles: { reviewer: "absent" },
      models: { reviewer: "absent-default" },
      status: "skipped",
      skipped: "absent: No credential found.",
    });
    expect(reported).toEqual(["reviewer=good", "reviewer=quiet", "reviewer=limited"]);
    expect(matrixRan(results)).toBe(true);

    const table = renderMatrixMarkdown(results);
    expect(table).toContain("| Configuration | Models | Recall | False-positive rate | Cost |");
    expect(table).toContain("| reviewer\\=good | reviewer big | 100% (1/1) | 0% | $0.50 |");
    expect(table).toMatch(/reviewer\\=limited .*\| 2 \| 2 \|/);
    // The reason is a harness's message, so it's escaped.
    expect(table).toContain("| skipped: absent\\: No credential found\\. | | | | | |");
    expect(table).toContain("lower bound");
  }, 60_000);

  it("keeps a later run's failures in the matrix results", async () => {
    const fixtures = (await loadFixtures(FIXTURES)).filter((f) => f.name === "off-by-one");
    const flaky: EvalProvider = {
      ...fakeProvider("flaky", () => [OFF_BY_ONE]),
      create: (): Harness => ({
        id: "flaky",
        run: async (options) => {
          if (options.runId?.includes("-run-2") === true) {
            throw new HarnessError("timeout", "the second run failed");
          }
          return {
            output: options.schema.parse({ findings: [OFF_BY_ONE] }),
            transcriptKey: "t",
            usage: { costUsd: 0.1 },
          };
        },
      }),
    };
    const results = await runMatrix(
      fixtures,
      matrixAssignments({ providers: "flaky" }, { flaky }),
      {
        providers: { flaky },
        env: {},
        harnessFor: (provider) => provider.create({ transcripts: undefined as never, env: {} }),
        models: {},
        batchTimeoutMs: 1000,
        workRoot,
        repeat: 2,
      },
    );
    expect(
      matrixResultsSchema.parse(results).configurations[0]?.fixtures?.[0]?.repeatErrors,
    ).toEqual(["batch 1: timeout: the second run failed"]);
    expect(renderMatrixMarkdown(results)).toContain("A later run failed on a row above");
  }, 60_000);

  it("says nothing ran when every configuration was skipped or failed", () => {
    const results: MatrixResults = {
      version: 1,
      startedAt: "2026-11-14T00:00:00.000Z",
      finishedAt: "2026-11-14T00:00:01.000Z",
      fixtures: ["a"],
      configurations: [
        {
          label: "reviewer=claude",
          roles: { reviewer: "claude" },
          models: { reviewer: "sonnet" },
          status: "skipped",
          skipped: "claude: no credential",
        },
      ],
    };
    expect(matrixRan(results)).toBe(false);
  });
});
