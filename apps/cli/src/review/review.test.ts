import { describe, expect, it, vi } from "vitest";
import { run } from "../cli.js";
import { terminalSafe } from "./output.js";
import type { ReviewDeps } from "./pipeline.js";
import type { ReviewEnvironmentFactory } from "./review.js";
import { parseTarget } from "./target.js";
import { resolveGitHubToken } from "./token.js";

describe("parseTarget", () => {
  it.each([
    ["acme/shop#7", { owner: "acme", repo: "shop", number: 7 }],
    ["https://github.com/acme/shop/pull/7", { owner: "acme", repo: "shop", number: 7 }],
    ["https://github.com/acme/shop/pull/7/files", { owner: "acme", repo: "shop", number: 7 }],
  ])("reads %s", (text, target) => {
    expect(parseTarget(text)).toEqual(target);
  });

  it.each([
    "acme/shop",
    "acme#7",
    "acme/shop#0",
    "a/../b#1",
    "acme/..#1",
    "http://github.com/a/b/pull/1",
  ])("refuses %s", (text) => {
    expect(parseTarget(text)).toBeUndefined();
  });
});

describe("resolveGitHubToken", () => {
  it("prefers GITHUB_TOKEN, then GH_TOKEN, then gh", async () => {
    const gh = vi.fn(async () => "from-gh");
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }, gh)).toBe("a");
    expect(await resolveGitHubToken({ GH_TOKEN: "b" }, gh)).toBe("b");
    expect(await resolveGitHubToken({}, gh)).toBe("from-gh");
  });

  it("is undefined when gh is missing or logged out", async () => {
    expect(
      await resolveGitHubToken({}, async () => {
        throw new Error("gh: not found");
      }),
    ).toBeUndefined();
  });
});

describe("terminalSafe", () => {
  it("drops escape sequences and other controls but keeps newlines and tabs", () => {
    expect(terminalSafe("a\u001b]0;pwned\u0007b\tc\nd\u009be‮f")).toBe("a]0;pwnedb\tc\ndef");
  });
});

describe("lgtmoose review", () => {
  it("shows its help without building any I/O", async () => {
    const environment = vi.fn();
    const result = await run(["review", "--help"], { reviewEnvironment: environment });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: lgtmoose review");
    expect(environment).not.toHaveBeenCalled();
  });

  it.each([
    [["acme/shop#7"], "Pass --dry-run"],
    [["acme/shop", "--dry-run"], "isn't a pull request"],
    [["--dry-run"], "Give one pull request"],
    [["acme/shop#7", "--dry-run", "--timeout", "0"], "--timeout"],
    [["acme/shop#7", "--dry-run", "--model", "a b"], "isn't a model name"],
    [["acme/shop#7", "--dry-run", "--nope"], "Unknown option"],
  ])("refuses %j before touching GitHub", async (argv, message) => {
    const environment = vi.fn();
    const result = await run(["review", ...argv], { reviewEnvironment: environment });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(environment).not.toHaveBeenCalled();
  });

  it("reports a failure without a stack trace or control characters", async () => {
    const environment: ReviewEnvironmentFactory = async () => {
      throw new Error("No GitHub token.\u001b[2J");
    };
    const result = await run(["review", "acme/shop#7", "--dry-run"], {
      reviewEnvironment: environment,
    });
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "No GitHub token.[2J\n" });
  });

  it("passes the flags to the environment", async () => {
    const environment = vi.fn<ReviewEnvironmentFactory>(async () => ({
      transcriptDir: "/tmp/t",
      deps: {
        github: {
          pull: async () => {
            throw new Error("stop here");
          },
        },
      } as unknown as ReviewDeps,
    }));
    const result = await run(
      [
        "review",
        "https://github.com/acme/shop/pull/7",
        "--dry-run",
        "--json",
        "--model",
        "opus",
        "--timeout",
        "2",
      ],
      { reviewEnvironment: environment },
    );
    expect(result.stderr).toBe("stop here\n");
    expect(environment).toHaveBeenCalledWith({
      target: { owner: "acme", repo: "shop", number: 7 },
      json: true,
      model: "opus",
      timeoutMs: 120_000,
      transcripts: undefined,
      claude: undefined,
    });
  });
});
