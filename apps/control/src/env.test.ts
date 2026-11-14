import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_TIMEOUT_MS,
  readCommand,
  readControlEnv,
  readReviewSettings,
} from "./env.js";

describe("readReviewSettings", () => {
  it("defaults to shadow mode and the default timeout", () => {
    expect(readReviewSettings({})).toEqual({
      model: "",
      batchTimeoutMs: DEFAULT_BATCH_TIMEOUT_MS,
      shadow: true,
    });
  });

  it("posts only on an explicit false", () => {
    expect(readReviewSettings({ LGTMOOSE_SHADOW: "false" }).shadow).toBe(false);
    expect(readReviewSettings({ LGTMOOSE_SHADOW: "no" }).shadow).toBe(true);
  });

  it("rejects a timeout that isn't a positive whole number", () => {
    for (const value of ["0", "-1", "1.5", "soon"]) {
      expect(() => readReviewSettings({ LGTMOOSE_BATCH_TIMEOUT_MS: value })).toThrow();
    }
  });
});

describe("readCommand", () => {
  const base = { LGTMOOSE_EXECUTION_ARN: "arn:exec" };

  it("reads each command's inputs", () => {
    expect(
      readCommand({
        ...base,
        LGTMOOSE_COMMAND: "prepare",
        LGTMOOSE_JOB: "{}",
        LGTMOOSE_TASK_TOKEN: "t",
      }),
    ).toEqual({ command: "prepare", executionArn: "arn:exec", job: "{}", taskToken: "t" });
    expect(readCommand({ ...base, LGTMOOSE_COMMAND: "post", LGTMOOSE_RUN_ID: "r" })).toEqual({
      command: "post",
      executionArn: "arn:exec",
      runId: "r",
    });
    expect(readCommand({ ...base, LGTMOOSE_COMMAND: "fail" })).toEqual({
      command: "fail",
      executionArn: "arn:exec",
      error: "unknown error",
    });
  });

  it("names what's missing", () => {
    expect(() => readCommand({ ...base, LGTMOOSE_COMMAND: "post" })).toThrow("LGTMOOSE_RUN_ID");
    expect(() => readCommand({ LGTMOOSE_COMMAND: "post" })).toThrow("LGTMOOSE_EXECUTION_ARN");
    expect(() => readCommand({ ...base, LGTMOOSE_COMMAND: "deploy" })).toThrow("Unknown");
  });
});

describe("readControlEnv", () => {
  it("reads every setting", () => {
    expect(
      readControlEnv({
        ARTIFACT_BUCKET: "bucket",
        DATABASE_SECRET_ARN: "arn:db",
        DATABASE_NAME: "lgtmoose",
        GITHUB_APP_SECRET_ARN: "arn:gh",
      }),
    ).toEqual({
      artifactBucket: "bucket",
      databaseSecretArn: "arn:db",
      databaseName: "lgtmoose",
      githubAppSecretArn: "arn:gh",
    });
  });

  it("names the missing ones, counting blank as missing", () => {
    expect(readControlEnv({ ARTIFACT_BUCKET: " " })).toEqual({
      missing: ["ARTIFACT_BUCKET", "DATABASE_SECRET_ARN", "DATABASE_NAME", "GITHUB_APP_SECRET_ARN"],
    });
  });
});
