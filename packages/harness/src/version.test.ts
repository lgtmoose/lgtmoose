import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_VERSION, CODEX_VERSION, CURSOR_AGENT_VERSION } from "./version.js";

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

describe("CURSOR_AGENT_VERSION", () => {
  it("is an exact build that matches the sandbox image", async () => {
    expect(CURSOR_AGENT_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/);
    const dockerfile = await readFile(
      join(import.meta.dirname, "../../../infra/sandbox/Dockerfile"),
      "utf8",
    );
    expect(/^ARG CURSOR_AGENT_VERSION=(\S+)$/m.exec(dockerfile)?.[1]).toBe(CURSOR_AGENT_VERSION);
    expect(dockerfile).toContain("/lab/${CURSOR_AGENT_VERSION}/linux/");
  });

  it("is verified by checksum unless the build opts out explicitly", async () => {
    const dockerfile = await readFile(
      join(import.meta.dirname, "../../../infra/sandbox/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      'sha256sum -c -; \\\n  elif [ "${ALLOW_UNVERIFIED_CURSOR}" = "1" ]',
    );
    expect(dockerfile).toMatch(
      /else \\\n\s+echo "CURSOR_AGENT_SHA256 is not set[^\n]*\n\s+exit 1;/,
    );
  });
});
