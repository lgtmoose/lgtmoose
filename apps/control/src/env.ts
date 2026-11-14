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

/** Reads the named variables, trimmed, or says which are missing (blank counts). */
function readVariables<K extends string>(
  env: Env,
  variables: Record<K, string>,
): Record<K, string> | { missing: string[] } {
  const missing = Object.values<string>(variables).filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { missing };
  const entries = Object.entries<string>(variables).map(([key, name]) => [
    key,
    env[name]?.trim() ?? "",
  ]);
  return Object.fromEntries(entries) as Record<K, string>;
}

/** Reads the control task's settings, or says which variables are missing (blank counts). */
export function readControlEnv(env: Env): ControlEnv | { missing: string[] } {
  return readVariables(env, VARIABLES);
}

/** What the dispatcher Lambda reads from its environment, set by the Workflow stack. */
export interface DispatchEnv {
  stateMachineArn: string;
  /** Where messages that aren't valid jobs go. */
  deadLetterQueueUrl: string;
  databaseSecretArn: string;
  databaseName: string;
}

/** Reads the dispatcher's settings, or says which variables are missing (blank counts). */
export function readDispatchEnv(env: Env): DispatchEnv | { missing: string[] } {
  return readVariables(env, {
    stateMachineArn: "STATE_MACHINE_ARN",
    deadLetterQueueUrl: "DEAD_LETTER_QUEUE_URL",
    databaseSecretArn: VARIABLES.databaseSecretArn,
    databaseName: VARIABLES.databaseName,
  });
}

/** What the reconciler Lambda reads from its environment, set by the Workflow stack. */
export interface ReconcileEnv {
  /** The gateway's FIFO job queue, where missed PRs are queued. */
  jobQueueUrl: string;
  databaseSecretArn: string;
  databaseName: string;
  githubAppSecretArn: string;
  /** GitHub orgs or users whose repositories may be reviewed. */
  allowedOrgs: string[];
  /** Labels are left alone in shadow mode. Anything but "false" is on. */
  shadow: boolean;
  /** `RECONCILE_LOOKBACK_HOURS`: reviews are queued only for PRs updated this recently. */
  lookbackHours: number;
}

export const DEFAULT_RECONCILE_LOOKBACK_HOURS = 24;

/** Reads the reconciler's settings, or says which variables are missing (blank counts). */
export function readReconcileEnv(env: Env): ReconcileEnv | { missing: string[] } {
  const read = readVariables(env, {
    jobQueueUrl: "JOB_QUEUE_URL",
    databaseSecretArn: VARIABLES.databaseSecretArn,
    databaseName: VARIABLES.databaseName,
    githubAppSecretArn: VARIABLES.githubAppSecretArn,
    allowedOrgs: "ALLOWED_ORGS",
  });
  if ("missing" in read) return read;
  const allowedOrgs = read.allowedOrgs
    .split(",")
    .map((org) => org.trim())
    .filter((org) => org.length > 0);
  if (allowedOrgs.length === 0) return { missing: ["ALLOWED_ORGS"] };
  const lookback = env.RECONCILE_LOOKBACK_HOURS?.trim();
  const lookbackHours = lookback ? Number(lookback) : DEFAULT_RECONCILE_LOOKBACK_HOURS;
  if (!Number.isSafeInteger(lookbackHours) || lookbackHours <= 0) {
    throw new Error("RECONCILE_LOOKBACK_HOURS must be a whole number of hours.");
  }
  return {
    ...read,
    allowedOrgs,
    shadow: env.LGTMOOSE_SHADOW?.trim() !== "false",
    lookbackHours,
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
  | { command: "post"; executionArn: string; runId: string; taskToken: string }
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
      return {
        command,
        executionArn,
        runId: need("LGTMOOSE_RUN_ID"),
        taskToken: need("LGTMOOSE_TASK_TOKEN"),
      };
    case "fail":
      return { command, executionArn, error: env.LGTMOOSE_ERROR?.trim() || "unknown error" };
    default:
      throw new Error(`Unknown LGTMOOSE_COMMAND ${JSON.stringify(command.slice(0, 40))}.`);
  }
}
