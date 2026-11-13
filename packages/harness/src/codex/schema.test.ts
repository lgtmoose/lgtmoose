import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dropOptionalNulls, strictSchema } from "./schema.js";

const finding = z.object({
  title: z.string(),
  line: z.number().int(),
  suggestion: z.string().optional(),
  tags: z.array(z.object({ name: z.string(), note: z.string().optional() })).optional(),
});
const output = z.object({ findings: z.array(finding) });
const json = z.toJSONSchema(output, { io: "input", target: "draft-7" });

describe("strictSchema", () => {
  it("requires every property, allows no others and makes optional ones nullable", () => {
    const strict = strictSchema(json) as {
      required: string[];
      additionalProperties: boolean;
      properties: { findings: { items: Record<string, unknown> } };
    };
    expect(strict.required).toEqual(["findings"]);
    expect(strict.additionalProperties).toBe(false);
    const item = strict.properties.findings.items as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type?: unknown; anyOf?: unknown[] }>;
    };
    expect(item.required).toEqual(["title", "line", "suggestion", "tags"]);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.title?.type).toBe("string");
    expect(item.properties.suggestion?.type).toEqual(["string", "null"]);
    expect(item.properties.tags?.type).toEqual(["array", "null"]);
  });

  it("handles nested arrays of objects", () => {
    const strict = strictSchema(json) as {
      properties: {
        findings: {
          items: {
            properties: {
              tags: { items: { required: string[]; properties: { note: { type: unknown } } } };
            };
          };
        };
      };
    };
    const tag = strict.properties.findings.items.properties.tags.items;
    expect(tag.required).toEqual(["name", "note"]);
    expect(tag.properties.note.type).toEqual(["string", "null"]);
  });

  it("wraps a schema without a single type in anyOf to make it nullable", () => {
    const strict = strictSchema({
      type: "object",
      properties: { either: { anyOf: [{ type: "string" }, { type: "number" }] } },
    }) as { properties: { either: { anyOf: unknown[] } } };
    expect(strict.properties.either.anyOf).toEqual([
      { anyOf: [{ type: "string" }, { type: "number" }] },
      { type: "null" },
    ]);
  });
});

describe("dropOptionalNulls", () => {
  it("removes nulls the strict form added for optional fields, at any depth", () => {
    const answer = {
      findings: [
        { title: "a", line: 1, suggestion: null, tags: null },
        { title: "b", line: 2, suggestion: "x", tags: [{ name: "n", note: null }] },
      ],
    };
    const cleaned = dropOptionalNulls(answer, json);
    expect(cleaned).toEqual({
      findings: [
        { title: "a", line: 1 },
        { title: "b", line: 2, suggestion: "x", tags: [{ name: "n" }] },
      ],
    });
    expect(output.safeParse(cleaned).success).toBe(true);
  });

  it("keeps a null on a required field, so validation reports it", () => {
    const cleaned = dropOptionalNulls({ findings: [{ title: null, line: 1 }] }, json);
    expect(cleaned).toEqual({ findings: [{ title: null, line: 1 }] });
    expect(output.safeParse(cleaned).success).toBe(false);
  });
});
