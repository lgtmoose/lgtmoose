import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_DECLINE_REASON, agentFindingsMarkdown as cliMarkdown } from "@lgtmoose/core";
import {
  agentFindingsMarkdown as browserMarkdown,
  type AgentFinding,
} from "@lgtmoose/core/agent-markdown";
import { describe, expect, it } from "vitest";
import {
  DECLINE_REASON_LIMIT,
  answerRefusal,
  answerState,
  count,
  declineReasonProblem,
  duration,
  findingsQuery,
  learningRefusal,
  money,
  percent,
  parseRoute,
  pullRequestUrl,
  reviewCommentUrl,
  routeHash,
  severityLabel,
  signInMessage,
} from "./format.js";

describe("routes", () => {
  it("reads the page and repository from the hash", () => {
    expect(parseRoute("#/findings?repo=acme/api")).toEqual({ page: "findings", repo: "acme/api" });
    expect(parseRoute("#/runs")).toEqual({ page: "runs", repo: undefined });
    expect(parseRoute("#/signed-out?error=not-member")).toEqual({
      page: "signed-out",
      error: "not-member",
    });
    expect(parseRoute("")).toEqual({ page: "repos" });
    expect(parseRoute("#/whatever")).toEqual({ page: "repos" });
  });

  it("reads the bootstrap page, and links to a source comment it builds itself", () => {
    expect(parseRoute("#/bootstrap")).toEqual({ page: "bootstrap" });
    expect(routeHash({ page: "bootstrap" })).toBe("#/bootstrap");
    expect(reviewCommentUrl("acme/api", 7, 42, true)).toBe(
      "https://github.com/acme/api/pull/7#discussion_r42",
    );
    expect(reviewCommentUrl("acme/api", 7, 42, false)).toBe(
      "https://github.com/acme/api/pull/7#pullrequestreview-42",
    );
    expect(reviewCommentUrl("javascript:alert(1)", 7, 42, true)).toBeUndefined();
    expect(reviewCommentUrl("acme/api", 7, -1, true)).toBeUndefined();
  });

  it("drops a repository that isn't owner/name", () => {
    expect(parseRoute("#/findings?repo=javascript:alert(1)")).toEqual({
      page: "findings",
      repo: undefined,
    });
    expect(parseRoute("#/runs?repo=a/b/c")).toEqual({ page: "runs", repo: undefined });
  });

  it("reads the learnings status, usage and acceptance pages", () => {
    expect(parseRoute("#/learnings")).toEqual({ page: "learnings", status: "pending" });
    expect(parseRoute("#/learnings?status=retired")).toEqual({
      page: "learnings",
      status: "retired",
    });
    expect(parseRoute("#/learnings?status=<x>")).toEqual({ page: "learnings", status: "pending" });
    expect(parseRoute("#/usage")).toEqual({ page: "usage" });
    expect(parseRoute("#/acceptance")).toEqual({ page: "acceptance" });
    expect(routeHash({ page: "learnings", status: "pending" })).toBe("#/learnings");
    expect(routeHash({ page: "learnings", status: "active" })).toBe("#/learnings?status=active");
    expect(routeHash({ page: "usage" })).toBe("#/usage");
  });

  it("writes routes back as hashes", () => {
    expect(routeHash({ page: "findings", repo: "acme/api" })).toBe("#/findings?repo=acme%2Fapi");
    expect(routeHash({ page: "repos" })).toBe("#/");
  });

  it("reads one pull request's findings, only with a repository and a plain number", () => {
    expect(parseRoute("#/findings?repo=acme/api&pr=12")).toEqual({
      page: "findings",
      repo: "acme/api",
      pr: 12,
    });
    expect(routeHash({ page: "findings", repo: "acme/api", pr: 12 })).toBe(
      "#/findings?repo=acme%2Fapi&pr=12",
    );
    for (const pr of ["0", "-1", "1.5", "12abc", "1e3", "99999999999"]) {
      expect(parseRoute(`#/findings?repo=acme/api&pr=${pr}`)).toEqual({
        page: "findings",
        repo: "acme/api",
      });
    }
    expect(parseRoute("#/findings?pr=12")).toEqual({ page: "findings", repo: undefined });
    expect(findingsQuery(undefined, undefined)).toBe("");
    expect(findingsQuery("acme/api", undefined)).toBe("?repo=acme%2Fapi");
    expect(findingsQuery("acme/api", 12)).toBe("?repo=acme%2Fapi&pr=12");
  });
});

describe("copy for agent", () => {
  it("is the CLI's markdown, from the browser-safe entry point", () => {
    const findings: AgentFinding[] = [
      {
        id: "0b61857d-3dc4-43e5-9bb2-6eafd3446db7",
        repo: "acme/api",
        number: 12,
        severity: "blocking",
        ruleCategory: "authz",
        title: "Missing check",
        body: "The handler skips the owner check.",
        path: "src/a.ts",
        line: 3,
        source: "self",
      },
    ];
    const input = { repo: "acme/api", number: 12, findings };
    expect(browserMarkdown(input)).toBe(cliMarkdown(input));
    expect(browserMarkdown(input)).toContain("lgtmoose findings ack <id> fixed");
  });
});

describe("labels", () => {
  it("says something for each sign-in error, and a generic line for unknown ones", () => {
    for (const error of ["denied", "expired", "not-member", "not-configured", "github", "x"]) {
      expect(signInMessage(error)).toEqual(expect.any(String));
    }
    expect(signInMessage(undefined)).toBeUndefined();
    // Never repeats the code it was given.
    expect(signInMessage("<b>hi</b>")).not.toContain("<b>");
  });

  it("formats severity, money and durations", () => {
    expect(severityLabel("should_fix")).toBe("Should fix");
    expect(money(undefined)).toBe("—");
    expect(money(0.1234)).toBe("$0.1234");
    expect(money(12)).toBe("$12.00");
    expect(duration("2026-11-15T10:00:00Z", "2026-11-15T10:03:20Z")).toBe("3m 20s");
    expect(duration("2026-11-15T10:00:00Z", undefined)).toBe("—");
  });

  it("links a PR only from a valid repository and number", () => {
    expect(pullRequestUrl("acme/api", 3)).toBe("https://github.com/acme/api/pull/3");
    expect(pullRequestUrl('acme/api"><x', 3)).toBeUndefined();
    expect(pullRequestUrl("acme/api", -1)).toBeUndefined();
  });
});

describe("source", () => {
  it("never builds HTML from strings", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = (await readdir(dir)).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const text = await readFile(join(dir, name), "utf8");
      for (const sink of [
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
      ]) {
        expect(text, `${name} uses ${sink}`).not.toContain(sink);
      }
    }
  });
});

describe("numbers and refusals", () => {
  it("formats shares and counts", () => {
    expect(percent(0.625)).toBe("63%");
    expect(percent(undefined)).toBe("—");
    expect(count(12345)).toBe("12,345");
  });

  it("says why an answer wasn't taken, in the API's words where it has them", () => {
    expect(answerRefusal(403, "needs write access on acme/api")).toBe(
      "needs write access on acme/api",
    );
    expect(answerRefusal(403, undefined)).toEqual(expect.any(String));
    expect(answerRefusal(400, "a decline needs a reason")).toContain("a decline needs a reason");
    expect(answerRefusal(404, undefined)).toContain("isn't there");
    expect(answerRefusal(409, "a recheck can't check this finding")).toBe(
      "a recheck can't check this finding",
    );
    expect(answerRefusal(503, undefined)).toContain("Try again");
    expect(answerRefusal(500, undefined)).toContain("500");
  });

  it("checks a decline reason as the API does", () => {
    expect(DECLINE_REASON_LIMIT).toBe(MAX_DECLINE_REASON);
    expect(declineReasonProblem("   ")).toContain("needs a reason");
    expect(declineReasonProblem(`  ${"x".repeat(DECLINE_REASON_LIMIT)}  `)).toBeUndefined();
    expect(declineReasonProblem("x".repeat(DECLINE_REASON_LIMIT + 1))).toContain("at most");
    expect(declineReasonProblem("ok\u0000")).toContain("NUL");
    expect(declineReasonProblem("Covered by the caller's check")).toBeUndefined();
  });

  it("says when a finding waits for its recheck, and who said it's fixed", () => {
    expect(answerState({})).toBeUndefined();
    expect(answerState({ fixClaimedAt: "2026-11-23T10:00:00.000Z", fixClaimedBy: "octocat" })).toBe(
      "Fixed: waiting for recheck by octocat",
    );
    expect(answerState({ fixClaimedAt: "2026-11-23T10:00:00.000Z" })).toBe(
      "Fixed: waiting for recheck",
    );
  });

  it("says why a learning wasn't changed", () => {
    expect(learningRefusal(403, "needs write")).toBe("needs write");
    expect(learningRefusal(403, undefined)).toEqual(expect.any(String));
    expect(learningRefusal(404, undefined)).toContain("isn't there");
    expect(learningRefusal(500, undefined)).toContain("500");
  });
});
