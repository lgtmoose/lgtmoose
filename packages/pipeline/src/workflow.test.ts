import { describe, expect, it } from "vitest";
import {
  batchOutputSchema,
  batchRunId,
  batchTranscriptKeys,
  batchUrlsSchema,
  runKeys,
  wantsFallback,
} from "./workflow.js";

const RUN = "0f0e8c2a-4b1d-4c3e-9a7f-1234567890ab";

describe("runKeys", () => {
  it("keeps a run's objects under its own prefix", () => {
    const keys = runKeys(RUN);
    expect(keys.prepared).toBe(`runs/${RUN}/prepared.json`);
    expect(keys.checkout).toBe(`runs/${RUN}/checkout.tar.gz`);
    expect(keys.batchInput(3)).toBe(`runs/${RUN}/batches/3/input.json`);
    expect(keys.batchOutput(3)).toBe(`runs/${RUN}/batches/3/output.json`);
    expect(keys.batchTranscript(3, "transcripts/x/1.jsonl")).toBe(
      `runs/${RUN}/batches/3/transcripts/x/1.jsonl`,
    );
  });

  it.each(["../other", "", "abc", `${RUN}/../x`])("refuses a run ID like %j", (id) => {
    expect(() => runKeys(id)).toThrow("Not a run ID");
  });

  it("refuses a negative or fractional batch index", () => {
    expect(() => runKeys(RUN).batchInput(-1)).toThrow();
    expect(() => runKeys(RUN).batchInput(1.5)).toThrow();
  });
});

describe("batch transcripts", () => {
  it("names one key per attempt, under the batch's harness run ID", () => {
    expect(batchRunId(RUN, 2)).toBe(`${RUN}-batch-2`);
    expect(batchTranscriptKeys(RUN, 2)).toEqual([
      `transcripts/${RUN}-batch-2/1.jsonl`,
      `transcripts/${RUN}-batch-2/2.jsonl`,
      `transcripts/${RUN}-batch-2/3.jsonl`,
    ]);
  });
});

describe("batchOutputSchema", () => {
  it("takes findings or an error, not both or neither", () => {
    const base = { version: 1, index: 0, transcriptKeys: [] };
    expect(batchOutputSchema.safeParse({ ...base, findings: [] }).success).toBe(true);
    expect(batchOutputSchema.safeParse({ ...base, error: "timeout" }).success).toBe(true);
    expect(batchOutputSchema.safeParse(base).success).toBe(false);
    expect(batchOutputSchema.safeParse({ ...base, findings: [], error: "x" }).success).toBe(false);
  });

  it("takes a reply judge's judgement instead, and only a valid one", () => {
    const base = { version: 1, index: 3, transcriptKeys: [] };
    expect(
      batchOutputSchema.safeParse({ ...base, judgement: { kind: "question", text: "Because." } })
        .success,
    ).toBe(true);
    expect(
      batchOutputSchema.safeParse({ ...base, judgement: { kind: "question" }, findings: [] })
        .success,
    ).toBe(false);
    // The judge can't pick an action of its own.
    expect(batchOutputSchema.safeParse({ ...base, judgement: { kind: "approve" } }).success).toBe(
      false,
    );
    expect(
      batchOutputSchema.safeParse({ ...base, judgement: { kind: "other", resolve: true } }).success,
    ).toBe(false);
  });

  it("takes a ticket checker's coverage instead, and only a valid one", () => {
    const base = { version: 1, index: 4, transcriptKeys: [] };
    const coverage = { requirements: [{ text: "Round to cents", core: true, status: "met" }] };
    expect(batchOutputSchema.safeParse({ ...base, coverage }).success).toBe(true);
    expect(batchOutputSchema.safeParse({ ...base, coverage, findings: [] }).success).toBe(false);
    // The checker can't set a severity or a decision.
    expect(
      batchOutputSchema.safeParse({
        ...base,
        coverage: { requirements: [{ ...coverage.requirements[0], severity: "blocking" }] },
      }).success,
    ).toBe(false);
    expect(
      batchOutputSchema.safeParse({ ...base, coverage: { ...coverage, approve: true } }).success,
    ).toBe(false);
  });

  it("refuses unknown fields", () => {
    expect(
      batchOutputSchema.safeParse({ version: 1, index: 0, transcriptKeys: [], findings: [], x: 1 })
        .success,
    ).toBe(false);
  });
});

describe("batchUrlsSchema", () => {
  it("takes only https URLs", () => {
    const ok = {
      checkout: "https://b.s3.amazonaws.com/c",
      input: "https://b.s3.amazonaws.com/i",
      output: "https://b.s3.amazonaws.com/o",
      transcripts: {},
    };
    expect(batchUrlsSchema.safeParse(ok).success).toBe(true);
    expect(batchUrlsSchema.safeParse({ ...ok, input: "http://b/i" }).success).toBe(false);
    expect(batchUrlsSchema.safeParse({ ...ok, input: "file:///etc/passwd" }).success).toBe(false);
  });
});

describe("batch notes", () => {
  const base = { version: 1, index: 0, findings: [], transcriptKeys: [] };

  it("accepts notes within the soft limits, only with findings", () => {
    expect(batchOutputSchema.safeParse({ ...base, notes: ["exports total()"] }).success).toBe(true);
    expect(batchOutputSchema.safeParse({ ...base, notes: ["x".repeat(501)] }).success).toBe(false);
    expect(
      batchOutputSchema.safeParse({ ...base, notes: Array.from({ length: 31 }, (_, i) => `n${i}`) })
        .success,
    ).toBe(false);
    const failed = { version: 1, index: 0, error: "timeout: x", transcriptKeys: [] };
    expect(batchOutputSchema.safeParse({ ...failed, notes: ["n"] }).success).toBe(false);
  });
});

describe("wantsFallback", () => {
  const output = (fields: Record<string, unknown>) =>
    JSON.stringify({ version: 1, index: 0, transcriptKeys: [], ...fields });

  it("moves on after a limit, an auth failure or a prompt too large for the provider", () => {
    for (const kind of ["rate_limit", "plan_limit", "auth", "input_too_large"]) {
      expect(wantsFallback(output({ error: `${kind}: stopped` }))).toEqual({
        fallback: true,
        reason: kind,
      });
    }
  });

  it("stops when the batch was reviewed, or failed in a way another provider would too", () => {
    expect(wantsFallback(output({ findings: [] })).fallback).toBe(false);
    expect(wantsFallback(output({ error: "timeout: too slow" })).fallback).toBe(false);
    expect(wantsFallback(output({ error: "invalid_output: bad JSON" })).fallback).toBe(false);
    // Only the error's kind counts, not text further on.
    expect(wantsFallback(output({ error: "timeout: hit rate_limit: maybe" })).fallback).toBe(false);
  });

  it("moves on when there's no usable output", () => {
    expect(wantsFallback(undefined).fallback).toBe(true);
    expect(wantsFallback("not json").fallback).toBe(true);
    expect(wantsFallback(output({ findings: [], error: "both" })).fallback).toBe(true);
  });
});
