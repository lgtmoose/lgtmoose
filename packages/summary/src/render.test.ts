import type { Finding } from "@lgtmoose/core";
import type { FileDiff, Hunk } from "@lgtmoose/git";
import type { PlannedFile, SkippedFile } from "@lgtmoose/planner";
import { describe, expect, it } from "vitest";
import { GITHUB_COMMENT_LIMIT, renderSummary, type SummaryInput } from "./render.js";

function hunk(adds: number, dels = 0): Hunk {
  return {
    oldStart: 1,
    oldLines: dels,
    newStart: 1,
    newLines: adds,
    section: "",
    lines: [
      ...Array.from({ length: dels }, (_, i) => ({
        kind: "del" as const,
        oldLine: i + 1,
        text: "old",
      })),
      ...Array.from({ length: adds }, (_, i) => ({
        kind: "add" as const,
        newLine: i + 1,
        text: "new",
      })),
    ],
  };
}

function file(path: string, overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    path,
    status: "modified",
    oldBlob: "a".repeat(40),
    newBlob: "b".repeat(40),
    submodule: false,
    moved: false,
    mechanical: false,
    binary: false,
    hunks: [hunk(3, 1)],
    ...overrides,
  };
}

function planned(f: FileDiff, depth: PlannedFile["depth"] = "full", index = 0): PlannedFile {
  return { file: f, depth, tier: 8, changedLines: 4, index };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    rule_category: "correctness",
    severity: "blocking",
    path: "src/total.ts",
    line: 9,
    side: "RIGHT",
    title: "Loop skips the last item",
    body: "The loop stops one early.",
    evidence: "for (let i = 0; i < items.length - 1; i++) {",
    ...overrides,
  };
}

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  const total = file("src/total.ts");
  const app = file("src/app.ts", { mechanical: true });
  const moved = file("src/math/sum.ts", {
    status: "renamed",
    oldPath: "src/sum.ts",
    moved: true,
    hunks: [],
  });
  const lock = file("package-lock.json", { hunks: [hunk(40, 12)] });
  const vendored = file("vendor/lib/a.js", {
    status: "added",
    oldBlob: undefined,
    hunks: [hunk(200)],
  });
  const skipped: SkippedFile[] = [
    {
      file: lock,
      reason: "lockfile",
      glob: "**/package-lock.json",
      notes: ["1 package resolves from evil.example.com, not a known registry (first at line 10)"],
    },
    { file: vendored, reason: "vendored", glob: "vendor/**", newCode: true },
  ];
  return {
    headSha: "0123456789abcdef0123456789abcdef01234567",
    files: [total, app, moved, lock, vendored],
    plan: {
      files: [planned(total), planned(app, "mechanical", 1), planned(moved, "move", 2)],
      skipped,
    },
    decision: { event: "REQUEST_CHANGES", label: "Requires Changes" },
    findings: [
      finding(),
      finding({ severity: "nit", path: "src/app.ts", line: 2, title: "Unused import" }),
      finding({
        severity: "should_fix",
        line: 12,
        start_line: 10,
        title: "No test for an empty list",
      }),
    ],
    walkthrough: "Fixes the total.\n\nMoves sum into src/math and updates the import.",
    tickets: {
      provider: "Linear",
      tickets: [
        {
          key: "NIC-1",
          title: "Totals are wrong",
          url: "https://linear.app/x/issue/NIC-1",
          coverage: "partial",
          note: "No test for empty carts.",
        },
      ],
    },
    conventionFilesOmitted: ["docs/agents/extra.md"],
    findingsOverLimit: 2,
    ...overrides,
  };
}

describe("renderSummary", () => {
  it("renders every section", () => {
    expect(renderSummary(input())).toMatchSnapshot();
  });

  it("ends with model usage per provider, escaped", () => {
    const text = renderSummary(
      input({
        usage: [
          {
            providerId: "claude-max",
            runs: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            limitHits: 1,
            fallbacks: 3,
          },
          {
            providerId: "api_key*",
            runs: 4,
            inputTokens: 123_456,
            outputTokens: 7_890,
            costUsd: 0.4213,
            limitHits: 0,
            fallbacks: 0,
          },
        ],
      }),
    );
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      "_Model usage: claude\\-max (0 in, 0 out, 1 limit hit, 3 fallbacks) · api\\_key\\* (123.5k in, 7.9k out, $0.42)_",
    );
    expect(renderSummary(input())).not.toContain("Model usage");
  });

  it("lists files the PR no longer changes, with what they no longer add, escaped", () => {
    const summary = renderSummary(
      input({
        noLongerChanged: [{ path: "src/auth.ts", lines: ["requireAdmin(user); <!-- x -->"] }],
      }),
    );
    expect(summary).toContain("No longer changed by the PR");
    expect(summary).toContain("src\\/auth\\.ts");
    expect(summary).not.toContain("<!--");
  });

  it("says the label is unchanged when the decision was skipped for an older commit", () => {
    const text = renderSummary(
      input({ decision: { event: "COMMENT", reasons: ["the head moved during the run"] } }),
    );
    expect(text).toContain("- **Label:** unchanged (the review is for an older commit)");
  });

  it("is the same for the same data, with no hidden markers", () => {
    const text = renderSummary(input());
    expect(renderSummary(input())).toBe(text);
    expect(text).not.toContain("<!--");
  });

  it("leaves out ticket coverage and optional notes when there are none", () => {
    const full: Partial<SummaryInput> = input({ findingsOverLimit: 0 });
    delete full.tickets;
    delete full.conventionFilesOmitted;
    delete full.walkthrough;
    const text = renderSummary(full as SummaryInput);
    expect(text).not.toContain("Ticket coverage");
    expect(text).not.toContain("Convention files");
    expect(text).not.toContain("past the per-batch limit");
    expect(text).not.toContain("Walkthrough");
  });

  it("shows why a decision is weaker and which labels are missing", () => {
    const text = renderSummary(
      input({
        decision: {
          event: "COMMENT",
          label: "Ready for Review",
          reasons: ["The head moved during the run."],
        },
        missingLabels: ["Approved"],
      }),
    );
    expect(text).toContain(
      "**Decision:** Commented, no approval\n  - The head moved during the run\\.",
    );
    expect(text).toContain("no Approved label");
  });

  it("escapes untrusted text so it can't break tables, add HTML or ping people", () => {
    const text = renderSummary(
      input({
        findings: [
          finding({ title: "x | y </details><img src=x> @octocat #1", path: "src/a|b.ts" }),
        ],
        walkthrough: "<details><summary>hi</summary>\n![t](https://evil.example/p.png) @team",
      }),
    );
    // Every <, ! and [ from the untrusted text is backslash-escaped.
    expect(text).not.toMatch(/(^|[^\\])<(img|\/?details)/m);
    expect(text).not.toMatch(/(^|[^\\])!\[/m);
    expect(text).toContain("x \\| y \\<\\/details\\>\\<img src\\=x\\> \\@\u2060octocat \\#\u20601");
    expect(text).toContain("src\\/a\\|b\\.ts:9");
    expect(text).not.toMatch(/(^|[^\\])@octocat/);
  });

  it("groups the file table by folder when more than 10 files changed", () => {
    const files = Array.from({ length: 12 }, (_, i) =>
      file(i < 8 ? `packages/core/src/f${i}.ts` : `README${i}.md`),
    );
    const text = renderSummary(
      input({ files, plan: { files: files.map((f, i) => planned(f, "full", i)), skipped: [] } }),
    );
    expect(text).toContain("| Folder | Files | Lines |");
    expect(text).toContain("| packages\\/core\\/ | 8 | +24 −8 |");
    expect(text).toContain("| \\(repository root\\) | 4 | +12 −4 |");
    expect(text).toContain("#### packages\\/core\\/ (8 files)");
  });

  it("shows a one-line range as one line and binary files as binary", () => {
    const logo = file("logo.png", { binary: true, hunks: [] });
    const text = renderSummary(
      input({
        files: [logo],
        plan: { files: [], skipped: [{ file: logo, reason: "binary" }] },
        findings: [finding({ start_line: 9, line: 9 })],
        missingLabels: ["Approved", "Requires Changes"],
      }),
    );
    expect(text).toContain("| src\\/total\\.ts:9 |");
    expect(text).toContain("| logo\\.png | modified | binary | skipped (binary) |");
    expect(text).toContain("no Approved, Requires Changes labels");
  });

  it("keeps folder names out of HTML in the grouped table", () => {
    const files = Array.from({ length: 11 }, (_, i) =>
      file(`x<img src=1 onerror=alert(1)>/f${i}.ts`),
    );
    const text = renderSummary(
      input({ files, plan: { files: files.map((f, i) => planned(f, "full", i)), skipped: [] } }),
    );
    expect(text).not.toMatch(/(^|[^\\])<img/m);
    expect(text).not.toContain("<details>");
  });

  it("keeps the outcome when even the least detailed comment is long", () => {
    const long = "n".repeat(5_000);
    const lockfiles = Array.from({ length: 60 }, (_, i) => file(`lock${i}/package-lock.json`));
    const text = renderSummary(
      input({
        files: lockfiles,
        plan: {
          files: [],
          skipped: lockfiles.map((f) => ({
            file: f,
            reason: "lockfile" as const,
            notes: Array.from({ length: 50 }, () => long),
          })),
        },
        decision: {
          event: "COMMENT",
          label: "Ready for Review",
          reasons: Array.from({ length: 50 }, () => long),
        },
        conventionFilesOmitted: Array.from({ length: 500 }, () => long),
      }),
    );
    expect(text.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(text).toContain("**Decision:** Commented, no approval");
    expect(text).toContain("**Open findings:** 3");
    expect(text).toContain("…and 50 more files");
    expect(text.endsWith("…\n")).toBe(false);
  });

  it("cuts whole lines from the end as a last resort, and says so", () => {
    const text = renderSummary(input(), { maxLength: 900 });
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).toContain("**Decision:** Changes requested");
    expect(text).toContain(
      "The rest of this comment was cut to stay under GitHub's comment size limit.",
    );
    for (const line of text.split("\n")) expect(line.endsWith("\\")).toBe(false);
  });

  it("lists a small change without grouping", () => {
    expect(renderSummary(input())).toContain("| File | Status | Lines | Review |");
    expect(renderSummary(input())).not.toContain("| Folder |");
  });

  it("stays under GitHub's limit on a huge PR and says what it left out", () => {
    const files = Array.from({ length: 3000 }, (_, i) =>
      file(`packages/p${i % 40}/src/some/deep/path/file-${i}.ts`),
    );
    const findings = Array.from({ length: 2000 }, (_, i) =>
      finding({ line: i + 1, title: "t".repeat(180) }),
    );
    const text = renderSummary(
      input({
        files,
        findings,
        plan: { files: files.map((f, i) => planned(f, "full", i)), skipped: [] },
        walkthrough: "w ".repeat(20_000),
      }),
    );
    expect(text.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(text).toContain("Left out to stay under GitHub's comment size limit:");
    expect(text).toContain("**Open findings:** 2000 (2000 blocking, 0 should fix, 0 nit)");
  });

  it("caps long lists of skipped new code", () => {
    const added = Array.from({ length: 30 }, (_, i) =>
      file(`vendor/x/f${i}.js`, { status: "added", oldBlob: undefined }),
    );
    const text = renderSummary(
      input({
        files: added,
        plan: {
          files: [],
          skipped: added.map((f) => ({
            file: f,
            reason: "vendored" as const,
            newCode: true as const,
          })),
        },
      }),
    );
    expect(text).toContain("**New code, not reviewed:** 30 files");
    expect(text).toContain("…and 5 more");
  });
});
