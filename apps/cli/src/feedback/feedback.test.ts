import { join } from "node:path";
import { parseDeployConfig, STACK_NAMES, STACK_OUTPUTS } from "@lgtmoose/config";
import type { DeclinedFinding, FeedbackReport } from "@lgtmoose/core";
import { fixtureSpecSchema } from "@lgtmoose/evals";
import { describe, expect, it } from "vitest";
import { run } from "../cli.js";
import { declinedFixtureSpec, type FeedbackDeps } from "./feedback.js";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);

const declined = (over: Partial<DeclinedFinding> = {}): DeclinedFinding => ({
  repo: "acme/shop",
  prNumber: 7,
  path: "src/cart.ts",
  line: 12,
  startLine: 10,
  side: "RIGHT",
  category: "style",
  severity: "should_fix",
  title: "Prefer a guard clause",
  raisedAtSha: SHA,
  baseSha: BASE,
  ...over,
});

const report = (over: Partial<FeedbackReport> = {}): FeedbackReport => ({
  version: 1,
  generatedAt: "2026-06-01T00:00:00.000Z",
  windowDays: 90,
  threshold: 0.5,
  minSamples: 10,
  categories: [
    {
      category: "style",
      protected: false,
      findings: 20,
      fixed: 2,
      declined: 9,
      disputed: 1,
      thumbsUp: 0,
      thumbsDown: 3,
      accepted: 2,
      rejected: 12,
      acceptance: 2 / 14,
      flagged: true,
    },
    {
      category: "correctness",
      protected: false,
      findings: 30,
      fixed: 20,
      declined: 2,
      disputed: 0,
      thumbsUp: 4,
      thumbsDown: 0,
      accepted: 22,
      rejected: 2,
      acceptance: 22 / 24,
      flagged: false,
    },
  ],
  declined: [declined()],
  ...over,
});

function fakeDeps(options: {
  report?: FeedbackReport | undefined;
  files?: Record<string, string>;
  token?: string | undefined;
  deployed?: boolean;
}) {
  const written = new Map<string, string>();
  const deps: FeedbackDeps = {
    loadConfig: async () =>
      parseDeployConfig({
        region: "eu-west-1",
        allowedOrgs: ["acme"],
        providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
      }),
    stacks: () => ({
      physicalIds: async () => [],
      describe: async (name) =>
        name === STACK_NAMES.data && options.deployed !== false
          ? {
              status: "UPDATE_COMPLETE",
              outputs: { [STACK_OUTPUTS.data.artifactBucketName]: "artifacts" },
            }
          : undefined,
    }),
    readObject: async (_region, bucket, key) =>
      bucket === "artifacts" &&
      key === "reports/feedback/latest.json" &&
      options.report !== undefined
        ? JSON.stringify(options.report)
        : undefined,
    githubToken: async () => ("token" in options ? options.token : "t0ken"),
    fileAt: async (_token, repo, path, ref) => options.files?.[`${repo}:${path}@${ref}`],
    writeFile: async (path, text) => {
      written.set(path, text);
    },
    reportKey: "reports/feedback/latest.json",
  };
  return { deps, written };
}

const cli = (argv: string[], deps: FeedbackDeps) => run(argv, { feedbackDeps: async () => deps });

describe("lgtmoose feedback report", () => {
  it("prints acceptance per category, flagged ones first, with no automatic demotion", async () => {
    const { deps } = fakeDeps({ report: report() });
    const result = await cli(["feedback", "report"], deps);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/style\s.*14%\s+flagged/);
    expect(result.stdout).toMatch(/correctness\s.*92%/);
    expect(result.stdout).toContain("Nothing is demoted automatically.");
  });

  it("prints the report as JSON", async () => {
    const { deps } = fakeDeps({ report: report() });
    const result = await cli(["feedback", "report", "--json"], deps);
    expect(JSON.parse(result.stdout)).toEqual(report());
  });

  it("says when there's no report yet, or nothing deployed", async () => {
    expect((await cli(["feedback", "report"], fakeDeps({}).deps)).stderr).toMatch(
      /No feedback report yet/,
    );
    expect(
      (await cli(["feedback", "report"], fakeDeps({ report: report(), deployed: false }).deps))
        .stderr,
    ).toMatch(/deploy first/);
  });

  it("shows help, and refuses unknown subcommands", async () => {
    expect((await cli(["feedback"], fakeDeps({}).deps)).stdout).toMatch(/export-declined/);
    expect((await cli(["feedback", "nope"], fakeDeps({}).deps)).exitCode).toBe(1);
  });
});

describe("lgtmoose feedback export-declined", () => {
  it("writes a clean fixture whose mustNotFlag covers the declined lines", async () => {
    const { deps, written } = fakeDeps({
      report: report(),
      files: {
        [`acme/shop:src/cart.ts@${SHA}`]: "head code\n",
        [`acme/shop:src/cart.ts@${BASE}`]: "base code\n",
      },
    });
    const result = await cli(["feedback", "export-declined", "--out", "/tmp/out"], deps);
    expect(result.exitCode).toBe(0);
    const files = [...written.keys()];
    const dir = files
      .find((path) => path.endsWith("fixture.json"))
      ?.replace(/\/fixture\.json$/, "");
    expect(dir).toMatch(/^\/tmp\/out\/declined-acme-shop-7-[0-9a-f]{8}$/);
    if (dir === undefined) return;
    expect(written.get(join(dir, "head", "src/cart.ts"))).toBe("head code\n");
    expect(written.get(join(dir, "base", "src/cart.ts"))).toBe("base code\n");
    const spec = fixtureSpecSchema.parse(JSON.parse(written.get(join(dir, "fixture.json")) ?? ""));
    expect(spec).toMatchObject({
      kind: "clean",
      mustNotFlag: [{ path: "src/cart.ts", lines: [10, 12], categories: ["style"] }],
    });
    expect(result.stdout).toMatch(/hold your repository's code/);
  });

  it("skips removed lines, unsafe paths and files gone from the commit", async () => {
    const { deps, written } = fakeDeps({
      report: report({
        declined: [
          declined({ side: "LEFT" }),
          declined({ path: "../etc/passwd" }),
          declined({ path: "src/gone.ts" }),
        ],
      }),
    });
    const result = await cli(["feedback", "export-declined", "--out", "/tmp/out"], deps);
    expect(written.size).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/removed line/);
    expect(result.stdout).toMatch(/unsafe path/);
    expect(result.stdout).toMatch(/isn't at aaaaaaa/);
  });

  it("filters by repository, and needs --out and a GitHub token", async () => {
    const { deps } = fakeDeps({ report: report() });
    expect(
      (await cli(["feedback", "export-declined", "--out", "/o", "--repo", "other/repo"], deps))
        .stdout,
    ).toMatch(/No declined findings/);
    expect((await cli(["feedback", "export-declined"], deps)).stderr).toMatch(/--out/);
    const noToken = fakeDeps({ report: report(), token: undefined }).deps;
    expect((await cli(["feedback", "export-declined", "--out", "/o"], noToken)).stderr).toMatch(
      /GITHUB_TOKEN/,
    );
  });

  it("makes a spec the evals take for an added file, too", () => {
    expect(
      fixtureSpecSchema.safeParse(declinedFixtureSpec(declined({ startLine: undefined }))).success,
    ).toBe(true);
  });
});
