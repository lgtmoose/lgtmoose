import { recheckOutputSchema } from "@lgtmoose/core";
import type { Harness, HarnessRunOptions } from "@lgtmoose/harness";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runRecheck } from "./pipeline.js";

describe("runRecheck", () => {
  it("asks for the recheck's own output, where unsure means the finding still holds", async () => {
    const schemas: unknown[] = [];
    const harness: Harness = {
      id: "stub",
      run: async <T>(options: HarnessRunOptions<T>) => {
        schemas.push(options.schema);
        return {
          output: options.schema.parse({
            verdicts: [{ id: "F1", confirmed: true, reason: "Can't tell from the code." }],
          }),
          transcriptKey: "stub",
        };
      },
    };
    const outcome = await runRecheck(
      harness,
      { index: 3, prompt: "Check again" },
      { cwd: "/tmp", model: "haiku", timeoutMs: 1000, runId: "run" },
    );
    expect(outcome).toMatchObject({ index: 3, verdicts: [{ id: "F1", confirmed: true }] });
    expect(schemas).toEqual([recheckOutputSchema]);
    const json = JSON.stringify(z.toJSONSchema(recheckOutputSchema));
    expect(json).toContain("true when you're unsure or can't tell");
    expect(json).not.toContain("you can't show that it is");
  });
});
