import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_TIMEOUT_MS,
  readCommand,
  readControlEnv,
  readDispatchEnv,
  readReconcileEnv,
  readReviewSettings,
} from "./env.js";

describe("readReviewSettings", () => {
  it("defaults to shadow mode and the default timeout", () => {
    expect(readReviewSettings({})).toEqual({
      model: "",
      batchTimeoutMs: DEFAULT_BATCH_TIMEOUT_MS,
      shadow: true,
      maxReplyJudgements: 10,
    });
  });

  it("reads the most replies to judge per run", () => {
    expect(readReviewSettings({ LGTMOOSE_MAX_REPLY_JUDGEMENTS: "0" }).maxReplyJudgements).toBe(0);
    expect(() => readReviewSettings({ LGTMOOSE_MAX_REPLY_JUDGEMENTS: "-1" })).toThrow();
    expect(() => readReviewSettings({ LGTMOOSE_MAX_REPLY_JUDGEMENTS: "x" })).toThrow();
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
    expect(
      readCommand({
        ...base,
        LGTMOOSE_COMMAND: "post",
        LGTMOOSE_RUN_ID: "r",
        LGTMOOSE_TASK_TOKEN: "t",
      }),
    ).toEqual({ command: "post", executionArn: "arn:exec", runId: "r", taskToken: "t" });
    expect(readCommand({ ...base, LGTMOOSE_COMMAND: "fail" })).toEqual({
      command: "fail",
      executionArn: "arn:exec",
      error: "unknown error",
    });
  });

  it("names what's missing", () => {
    expect(() => readCommand({ ...base, LGTMOOSE_COMMAND: "post" })).toThrow("LGTMOOSE_RUN_ID");
    expect(() => readCommand({ ...base, LGTMOOSE_COMMAND: "post", LGTMOOSE_RUN_ID: "r" })).toThrow(
      "LGTMOOSE_TASK_TOKEN",
    );
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

describe("readDispatchEnv", () => {
  it("reads the dispatcher's variables, trimmed, or names the missing ones", () => {
    expect(
      readDispatchEnv({
        STATE_MACHINE_ARN: " arn:sm ",
        DEAD_LETTER_QUEUE_URL: "https://sqs/dlq",
        DATABASE_SECRET_ARN: "arn:secret",
        DATABASE_NAME: "lgtmoose",
      }),
    ).toEqual({
      stateMachineArn: "arn:sm",
      deadLetterQueueUrl: "https://sqs/dlq",
      databaseSecretArn: "arn:secret",
      databaseName: "lgtmoose",
    });
    expect(readDispatchEnv({ STATE_MACHINE_ARN: "arn:sm", DATABASE_NAME: " " })).toEqual({
      missing: ["DEAD_LETTER_QUEUE_URL", "DATABASE_SECRET_ARN", "DATABASE_NAME"],
    });
  });
});

describe("readReconcileEnv", () => {
  const env = {
    JOB_QUEUE_URL: "https://sqs/jobs.fifo",
    DATABASE_SECRET_ARN: "arn:db",
    DATABASE_NAME: "lgtmoose",
    GITHUB_APP_SECRET_ARN: "arn:app",
    ALLOWED_ORGS: " acme, beta ,",
  };

  it("reads the reconciler's variables, in shadow mode unless told otherwise", () => {
    expect(readReconcileEnv(env)).toEqual({
      jobQueueUrl: "https://sqs/jobs.fifo",
      databaseSecretArn: "arn:db",
      databaseName: "lgtmoose",
      githubAppSecretArn: "arn:app",
      allowedOrgs: ["acme", "beta"],
      shadow: true,
      lookbackHours: 24,
      feedback: { threshold: 0.5, minSamples: 10, maxComments: 100 },
    });
    expect(
      readReconcileEnv({ ...env, LGTMOOSE_SHADOW: "false", RECONCILE_LOOKBACK_HOURS: "6" }),
    ).toMatchObject({ shadow: false, lookbackHours: 6 });
    expect(() => readReconcileEnv({ ...env, RECONCILE_LOOKBACK_HOURS: "1.5" })).toThrow(
      "RECONCILE_LOOKBACK_HOURS",
    );
  });

  it("reads the feedback settings and the artifact bucket", () => {
    expect(
      readReconcileEnv({
        ...env,
        ARTIFACT_BUCKET: "artifacts",
        FEEDBACK_ACCEPTANCE_THRESHOLD: "0.3",
        FEEDBACK_MIN_SAMPLES: "5",
        FEEDBACK_MAX_COMMENTS: "0",
      }),
    ).toMatchObject({
      artifactBucket: "artifacts",
      feedback: { threshold: 0.3, minSamples: 5, maxComments: 0 },
    });
    expect(() => readReconcileEnv({ ...env, FEEDBACK_ACCEPTANCE_THRESHOLD: "2" })).toThrow(
      "FEEDBACK_ACCEPTANCE_THRESHOLD",
    );
    expect(() => readReconcileEnv({ ...env, FEEDBACK_MIN_SAMPLES: "0" })).toThrow(
      "FEEDBACK_MIN_SAMPLES",
    );
  });

  it("names missing variables, and an allowed-orgs list with no org in it", () => {
    expect(readReconcileEnv({ ...env, JOB_QUEUE_URL: "" })).toEqual({
      missing: ["JOB_QUEUE_URL"],
    });
    expect(readReconcileEnv({ ...env, ALLOWED_ORGS: " , " })).toEqual({
      missing: ["ALLOWED_ORGS"],
    });
  });
});
