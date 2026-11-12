import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonSchemas, serializeSchema } from "./json-schema.js";

describe("JSON schemas", () => {
  it.each(Object.entries(jsonSchemas()))("schema/%s is up to date", (name, schema) => {
    const committed = readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8");
    // If this fails, run `pnpm --filter @lgtmoose/config schema` and commit the result.
    expect(committed).toBe(serializeSchema(schema));
  });

  it("describes the provider auth options for editors", () => {
    const schema = JSON.stringify(jsonSchemas()["lgtmoose.config.schema.json"]);
    expect(schema).toContain("chatgpt-login");
    expect(schema).toContain("service-account");
  });
});
