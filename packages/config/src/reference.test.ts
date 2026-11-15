import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configReferenceMarkdown } from "./reference.js";

describe("configuration reference", () => {
  it("docs/configuration.md is up to date", () => {
    const committed = readFileSync(
      new URL("../../../docs/configuration.md", import.meta.url),
      "utf8",
    );
    // If this fails, run `pnpm --filter @lgtmoose/config docs` and commit the result.
    expect(committed).toBe(configReferenceMarkdown());
  });

  it("lists nested keys with their defaults and descriptions", () => {
    const page = configReferenceMarkdown();
    expect(page).toContain("| `providers[].id` (required) |");
    expect(page).toContain(
      '| `learnings.embeddings.provider` (required) | `"none"` or `"bedrock"`',
    );
    expect(page).toContain('With `provider: "bedrock"`.');
    // Outside code, angle brackets don't read as HTML.
    expect(page).toContain("lgtmoose/provider/&lt;id&gt;");
    expect(page).toContain("| `gate.nit_cap` |");
    expect(page).toContain("Most nits posted in one review.");
    // A pattern's alternatives don't split the table cell, on GitHub or in Jekyll.
    expect(page).toContain("<code>^(global&#124;us&#124;eu&#124;[a-z]+-[a-z]+\\d+)$</code>");
    const spans = [...page.matchAll(/`([^`\n]*)`/g)].map((match) => match[1] ?? "");
    expect(spans.filter((span) => span.includes("|"))).toEqual([]);
  });
});
