import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  guardScript,
  isAllowedGitCommand,
  TOOLS,
} from "./policy.js";

describe("tool rules", () => {
  it("has only read-only tools", () => {
    expect(TOOLS).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(ALLOWED_TOOLS).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff *)",
      "Bash(git --no-pager diff *)",
      "Bash(git log *)",
      "Bash(git --no-pager log *)",
      "Bash(git show *)",
      "Bash(git --no-pager show *)",
    ]);
    expect(DISALLOWED_TOOLS).toContain("Bash(git *--output*)");
    expect(DISALLOWED_TOOLS).toContain("Bash(git *--no-index*)");
  });
});

describe("isAllowedGitCommand", () => {
  it.each([
    "git diff",
    "git diff main...HEAD -- src/a.ts",
    "git log --oneline -5",
    "git log --format='%h %s' -1",
    'git log --format="%h %an"',
    "git show HEAD~1:src/a.ts",
    "git --no-pager show --stat abc123",
    "git log main..feature/x",
    "git diff base...head -- src/a.ts",
  ])("allows %s", (command) => {
    expect(isAllowedGitCommand(command)).toBe(true);
  });

  it.each([
    "git status",
    "git blame src/a.ts",
    "git -C /etc diff",
    "git -c core.pager=sh log",
    "git diff --output=out.txt",
    "git show --output out.txt HEAD",
    "git diff --no-index /etc/passwd a.txt",
    "git diff /dev/null /etc/passwd",
    "git diff --stat /dev/null /etc/passwd",
    "git diff -- /etc/hostname a.txt",
    "git diff ../outside a.txt",
    "git diff src/../../outside a.txt",
    "git diff --relative=/etc",
    "git diff -O/etc/passwd",
    "git diff --orderfile=order.txt",
    "git show HEAD:../x",
    "git diff --ext-diff",
    "git log --textconv",
    "git log | head",
    "git diff > out.txt",
    "git diff && rm -rf .",
    "git diff; env",
    "git diff $(touch x)",
    'git diff "$(touch x)"',
    "git diff `touch x`",
    "git diff $HOME",
    "git log -- '*.ts' &",
    "git diff *.ts",
    "git diff\nenv",
    "git diff ~/x",
    "git diff --src-prefix=~/x",
    "git diff 'unterminated",
    "cat a.txt",
    "ls",
    "env",
    "/usr/bin/git diff",
    "git",
    "",
  ])("refuses %j", (command) => {
    expect(isAllowedGitCommand(command)).toBe(false);
  });
});

describe("guardScript", () => {
  async function runGuard(event: unknown): Promise<{ status: number | null; stderr: string }> {
    const dir = await mkdtemp(join(tmpdir(), "lgtmoose-guard-"));
    try {
      const path = join(dir, "guard.cjs");
      await writeFile(path, guardScript());
      const result = spawnSync(process.execPath, [path], {
        input: typeof event === "string" ? event : JSON.stringify(event),
        encoding: "utf8",
      });
      return { status: result.status, stderr: result.stderr };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("lets plain git diff, log and show through", async () => {
    const result = await runGuard({ tool_name: "Bash", tool_input: { command: "git log -3" } });
    expect(result.status).toBe(0);
  });

  it("blocks other Bash commands with exit code 2 and a reason", async () => {
    const result = await runGuard({ tool_name: "Bash", tool_input: { command: "cat .env" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("only plain `git diff`, `git log` and `git show`");
  });

  it("leaves other tools to the permission rules", async () => {
    const result = await runGuard({ tool_name: "Read", tool_input: { file_path: "a.ts" } });
    expect(result.status).toBe(0);
  });

  it("blocks when it can't read the event", async () => {
    expect((await runGuard("not json")).status).toBe(2);
    expect((await runGuard({ tool_name: "Bash", tool_input: {} })).status).toBe(2);
  });
});
