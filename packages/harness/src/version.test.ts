import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_VERSION, CODEX_VERSION } from "./version.js";

describe("CLAUDE_CODE_VERSION", () => {
  it("is an exact version", () => {
    expect(CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the version the sandbox image installs", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "../../../infra/sandbox/Dockerfile"),
      "utf8",
    );
    const pinned = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(pinned).toBe(CLAUDE_CODE_VERSION);
    expect(dockerfile).toContain('"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
  });
});

describe("CODEX_VERSION", () => {
  it("is an exact version that matches the sandbox image", async () => {
    expect(CODEX_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const dockerfile = await readFile(
      join(import.meta.dirname, "../../../infra/sandbox/Dockerfile"),
      "utf8",
    );
    expect(/^ARG CODEX_VERSION=(\S+)$/m.exec(dockerfile)?.[1]).toBe(CODEX_VERSION);
    expect(dockerfile).toContain('"@openai/codex@${CODEX_VERSION}"');
  });
});
