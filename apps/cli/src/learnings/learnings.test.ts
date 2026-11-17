import {
  BOOTSTRAP_REQUEST_PREFIX,
  parseDeployConfig,
  STACK_NAMES,
  STACK_OUTPUTS,
} from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { run } from "../cli.js";
import type { LearningsDeps } from "./learnings.js";

function fakeDeps(options: { deployed?: boolean; cap?: number } = {}) {
  const puts: { region: string; bucket: string; key: string; body: string }[] = [];
  const deps: LearningsDeps = {
    loadConfig: async () =>
      parseDeployConfig({
        region: "eu-west-1",
        allowedOrgs: ["acme"],
        providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
        ...(options.cap === undefined ? {} : { learnings: { bootstrapMaxCostUsd: options.cap } }),
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
    async putObject(region, bucket, key, body) {
      puts.push({ region, bucket, key, body });
    },
  };
  return { deps, puts };
}

const learnings = (argv: string[], deps: LearningsDeps) =>
  run(["learnings", ...argv], { learningsDeps: async () => deps });

describe("lgtmoose learnings bootstrap", () => {
  it("leaves a request in the artifact bucket for the reconciler", async () => {
    const { deps, puts } = fakeDeps();
    const result = await learnings(["bootstrap", "--repo", "acme/shop", "--prs", "50"], deps);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("acme/shop's last 50 merged pull requests");
    expect(result.stdout).toContain("$5.00");
    expect(puts).toHaveLength(1);
    expect(puts[0]?.bucket).toBe("artifacts");
    expect(puts[0]?.key.startsWith(BOOTSTRAP_REQUEST_PREFIX)).toBe(true);
    expect(JSON.parse(puts[0]?.body ?? "")).toEqual({ version: 1, repo: "acme/shop", maxPrs: 50 });
  });

  it("asks for a lower cap and a resume", async () => {
    const { deps, puts } = fakeDeps({ cap: 10 });
    const result = await learnings(
      ["bootstrap", "--repo", "acme/shop", "--max-cost", "2.5", "--resume"],
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("$2.50");
    expect(JSON.parse(puts[0]?.body ?? "")).toMatchObject({ maxCostUsd: 2.5, resume: true });
  });

  it("refuses a bad repository or limits, and an undeployed deployment", async () => {
    const { deps, puts } = fakeDeps();
    expect((await learnings(["bootstrap"], deps)).exitCode).toBe(1);
    expect((await learnings(["bootstrap", "--repo", "acme"], deps)).exitCode).toBe(1);
    expect((await learnings(["bootstrap", "--repo", "a/b", "--prs", "5000"], deps)).exitCode).toBe(
      1,
    );
    expect(
      (await learnings(["bootstrap", "--repo", "a/b", "--max-cost", "-1"], deps)).exitCode,
    ).toBe(1);
    expect((await learnings(["forget"], deps)).exitCode).toBe(1);
    expect(puts).toHaveLength(0);
    const undeployed = fakeDeps({ deployed: false });
    const result = await learnings(["bootstrap", "--repo", "acme/shop"], undeployed.deps);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("deploy first");
  });

  it("shows its help", async () => {
    const { deps } = fakeDeps();
    const result = await learnings(["--help"], deps);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("learnings bootstrap --repo");
  });
});
