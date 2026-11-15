import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  count,
  duration,
  learningRefusal,
  money,
  percent,
  parseRoute,
  pullRequestUrl,
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

  it("says why a learning wasn't changed", () => {
    expect(learningRefusal(403, "needs write")).toBe("needs write");
    expect(learningRefusal(403, undefined)).toEqual(expect.any(String));
    expect(learningRefusal(404, undefined)).toContain("isn't there");
    expect(learningRefusal(500, undefined)).toContain("500");
  });
});
