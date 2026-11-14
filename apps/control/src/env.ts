/** What the control task reads from its environment, set by the Workflow stack. */
export interface ControlEnv {
  /** The artifact bucket: batch inputs, findings and transcripts. */
  artifactBucket: string;
  /** The database's generated secret: host, port, username and password. */
  databaseSecretArn: string;
  /** The database name, which the generated secret doesn't hold. */
  databaseName: string;
  /** The GitHub App secret (App ID, private key and the rest). */
  githubAppSecretArn: string;
}

const VARIABLES = {
  artifactBucket: "ARTIFACT_BUCKET",
  databaseSecretArn: "DATABASE_SECRET_ARN",
  databaseName: "DATABASE_NAME",
  githubAppSecretArn: "GITHUB_APP_SECRET_ARN",
} as const satisfies Record<keyof ControlEnv, string>;

type Env = Readonly<Record<string, string | undefined>>;

/** Reads the control task's settings, or says which variables are missing (blank counts). */
export function readControlEnv(env: Env): ControlEnv | { missing: string[] } {
  const missing = Object.values(VARIABLES).filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { missing };
  const read = (name: string) => env[name]?.trim() ?? "";
  return {
    artifactBucket: read(VARIABLES.artifactBucket),
    databaseSecretArn: read(VARIABLES.databaseSecretArn),
    databaseName: read(VARIABLES.databaseName),
    githubAppSecretArn: read(VARIABLES.githubAppSecretArn),
  };
}

/** How the review runs, from the deploy config. The Workflow stack sets these on the task. */
export interface ReviewSettings {
  /** `LGTMOOSE_REVIEWER_MODEL`: the reviewer's model; empty for the harness's default. */
  model: string;
  /** `LGTMOOSE_BATCH_TIMEOUT_MS`: how long one batch's model run may take. */
  batchTimeoutMs: number;
  /** `LGTMOOSE_SHADOW`: record reviews instead of posting them. Anything but "false" is on. */
  shadow: boolean;
}

export const DEFAULT_BATCH_TIMEOUT_MS = 20 * 60_000;

export function readReviewSettings(env: Env): ReviewSettings {
  const timeout = env.LGTMOOSE_BATCH_TIMEOUT_MS?.trim();
  const batchTimeoutMs = timeout ? Number(timeout) : DEFAULT_BATCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(batchTimeoutMs) || batchTimeoutMs <= 0) {
    throw new Error("LGTMOOSE_BATCH_TIMEOUT_MS must be a whole number of milliseconds.");
  }
  return {
    model: env.LGTMOOSE_REVIEWER_MODEL?.trim() ?? "",
    batchTimeoutMs,
    // Shadow mode is the safe side: only an explicit "false" posts to GitHub.
    shadow: env.LGTMOOSE_SHADOW?.trim() !== "false",
  };
}

/**
 * One step of the review workflow, from the variables the state machine sets per task
 * (container overrides). Each names the execution, so the run can be found and failed.
 */
export type ControlCommand =
  | { command: "prepare"; executionArn: string; job: string; taskToken: string }
  | { command: "post"; executionArn: string; runId: string }
  | { command: "fail"; executionArn: string; error: string };

export function readCommand(env: Env): ControlCommand {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is not set.`);
    return value;
  };
  const command = need("LGTMOOSE_COMMAND");
  const executionArn = need("LGTMOOSE_EXECUTION_ARN");
  switch (command) {
    case "prepare":
      return {
        command,
        executionArn,
        job: need("LGTMOOSE_JOB"),
        taskToken: need("LGTMOOSE_TASK_TOKEN"),
      };
    case "post":
      return { command, executionArn, runId: need("LGTMOOSE_RUN_ID") };
    case "fail":
      return { command, executionArn, error: env.LGTMOOSE_ERROR?.trim() || "unknown error" };
    default:
      throw new Error(`Unknown LGTMOOSE_COMMAND ${JSON.stringify(command.slice(0, 40))}.`);
  }
}
