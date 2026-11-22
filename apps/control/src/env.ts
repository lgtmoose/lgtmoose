import { GITHUB_LOGIN } from "@lgtmoose/config";
import { DEFAULT_ACCEPTANCE_THRESHOLD, DEFAULT_MIN_SAMPLES } from "@lgtmoose/core";
import { DEFAULT_MAX_FEEDBACK_COMMENTS } from "./feedback.js";
import { DEFAULT_MAX_EXPLANATIONS } from "./explain.js";
import { DEFAULT_MAX_REPLY_JUDGEMENTS } from "./replies.js";

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
  /**
   * `LGTMOOSE_DATABASE_CA_FILE`: a PEM bundle the Postgres client trusts, and nothing else.
   * Unset on Lambda, which uses the runtime bundle.
   */
  databaseCaFile?: string;
}

const VARIABLES = {
  artifactBucket: "ARTIFACT_BUCKET",
  databaseSecretArn: "DATABASE_SECRET_ARN",
  databaseName: "DATABASE_NAME",
  githubAppSecretArn: "GITHUB_APP_SECRET_ARN",
} as const satisfies Record<Exclude<keyof ControlEnv, "databaseCaFile">, string>;

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
  const read = readVariables(env, VARIABLES);
  if ("missing" in read) return read;
  const databaseCaFile = env.LGTMOOSE_DATABASE_CA_FILE?.trim();
  return { ...read, ...(databaseCaFile ? { databaseCaFile } : {}) };
}

/** What the dispatcher Lambda reads from its environment, set by the Workflow stack. */
export interface DispatchEnv {
  stateMachineArn: string;
  /** Where messages that aren't valid jobs go. */
  deadLetterQueueUrl: string;
  databaseSecretArn: string;
  databaseName: string;
  /** `CONVERSATION_QUEUE_URL`: where comment jobs go. Unset, they're dropped as before. */
  conversationQueueUrl?: string;
  /** `LGTMOOSE_REVIEW_DEBOUNCE_SECONDS` (`reviewDebounceSeconds`): a push's wait. Unset: 60. */
  pushDebounceSeconds?: number;
}

/**
 * `LGTMOOSE_REVIEW_DEBOUNCE_SECONDS`: how long a push's review waits for the next push, 0 to
 * 1800 seconds. Unset or blank: the default. Anything else is a setup error.
 */
export function readDebounceSeconds(env: Env): number | undefined {
  const value = env.LGTMOOSE_REVIEW_DEBOUNCE_SECONDS?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 1800) {
    throw new Error("LGTMOOSE_REVIEW_DEBOUNCE_SECONDS must be a whole number from 0 to 1800.");
  }
  return seconds;
}

/** Reads the dispatcher's settings, or says which variables are missing (blank counts). */
export function readDispatchEnv(env: Env): DispatchEnv | { missing: string[] } {
  const read = readVariables(env, {
    stateMachineArn: "STATE_MACHINE_ARN",
    deadLetterQueueUrl: "DEAD_LETTER_QUEUE_URL",
    databaseSecretArn: VARIABLES.databaseSecretArn,
    databaseName: VARIABLES.databaseName,
  });
  if ("missing" in read) return read;
  const conversationQueueUrl = env.CONVERSATION_QUEUE_URL?.trim();
  const pushDebounceSeconds = readDebounceSeconds(env);
  return {
    ...read,
    ...(conversationQueueUrl ? { conversationQueueUrl } : {}),
    ...(pushDebounceSeconds === undefined ? {} : { pushDebounceSeconds }),
  };
}

/** What the conversation Lambda reads from its environment, set by the Workflow stack. */
export interface ConversationEnv {
  /** The gateway's FIFO job queue, where reviews a command asks for are queued. */
  jobQueueUrl: string;
  databaseSecretArn: string;
  databaseName: string;
  githubAppSecretArn: string;
  /** Nothing is written to GitHub in shadow mode. Anything but "false" is on. */
  shadow: boolean;
}

/** Reads the conversation Lambda's settings, or says which variables are missing. */
export function readConversationEnv(env: Env): ConversationEnv | { missing: string[] } {
  const read = readVariables(env, {
    jobQueueUrl: "JOB_QUEUE_URL",
    databaseSecretArn: VARIABLES.databaseSecretArn,
    databaseName: VARIABLES.databaseName,
    githubAppSecretArn: VARIABLES.githubAppSecretArn,
  });
  if ("missing" in read) return read;
  return { ...read, shadow: env.LGTMOOSE_SHADOW?.trim() !== "false" };
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
  /** `ARTIFACT_BUCKET`: where the feedback report goes. Without it, none is written. */
  artifactBucket?: string;
  /** Feedback signals (NIC-841): `FEEDBACK_*`. */
  feedback: { threshold: number; minSamples: number; maxComments: number };
  /**
   * `STATE_MACHINE_ARN`: the review workflow, which bootstraps from review history run on
   * (NIC-1080). Without it, none are started.
   */
  stateMachineArn?: string;
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
  const threshold = Number(
    env.FEEDBACK_ACCEPTANCE_THRESHOLD?.trim() || DEFAULT_ACCEPTANCE_THRESHOLD,
  );
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new Error("FEEDBACK_ACCEPTANCE_THRESHOLD must be a number from 0 to 1.");
  }
  const whole = (name: string, fallback: number, min: number) => {
    const value = Number(env[name]?.trim() || fallback);
    if (!Number.isSafeInteger(value) || value < min) {
      throw new Error(`${name} must be a whole number of at least ${min}.`);
    }
    return value;
  };
  const artifactBucket = env.ARTIFACT_BUCKET?.trim();
  return {
    ...read,
    allowedOrgs,
    shadow: env.LGTMOOSE_SHADOW?.trim() !== "false",
    lookbackHours,
    ...(artifactBucket ? { artifactBucket } : {}),
    feedback: {
      threshold,
      minSamples: whole("FEEDBACK_MIN_SAMPLES", DEFAULT_MIN_SAMPLES, 1),
      maxComments: whole("FEEDBACK_MAX_COMMENTS", DEFAULT_MAX_FEEDBACK_COMMENTS, 0),
    },
    ...(env.STATE_MACHINE_ARN?.trim() ? { stateMachineArn: env.STATE_MACHINE_ARN.trim() } : {}),
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
  /**
   * `LGTMOOSE_MAX_REPLY_JUDGEMENTS`: the most replies the reply judge reads per run. Left out
   * (tests), none are judged.
   */
  maxReplyJudgements?: number;
  /**
   * `LGTMOOSE_MAX_EXPLANATIONS`: the most `explain`s the explainer answers per PR per run.
   * Left out (tests), none are answered by a model.
   */
  maxExplanations?: number;
}

export const DEFAULT_BATCH_TIMEOUT_MS = 20 * 60_000;

/**
 * `LGTMOOSE_MAX_EXPLANATIONS` (`maxExplanations`): the most `explain`s answered by a model per
 * PR per run, for the control task and the conversation Lambda. Unset: the default.
 */
export function readMaxExplanations(env: Env): number {
  const value = env.LGTMOOSE_MAX_EXPLANATIONS?.trim();
  const limit = value ? Number(value) : DEFAULT_MAX_EXPLANATIONS;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("LGTMOOSE_MAX_EXPLANATIONS must be a whole number.");
  }
  return limit;
}

/**
 * `LGTMOOSE_COMMAND_HINT` (`commandHint`, NIC-1119): whether a comment using `@lgtmoose` where
 * the App is called something else gets the one-time hint. `true` or `false`, in any case; unset
 * or empty is the default, on. Anything else fails the Lambda at start rather than being guessed.
 */
export function readCommandHint(env: Env): boolean {
  const value = env.LGTMOOSE_COMMAND_HINT?.trim().toLowerCase() ?? "";
  if (value === "") return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("LGTMOOSE_COMMAND_HINT must be true or false.");
}

/**
 * `LGTMOOSE_COMMAND_ALIASES` (`commandAliases`, NIC-1119): other handles `@`-commands may use
 * besides the App's own, comma-separated. Unset or empty: none. A value that isn't a login fails
 * the Lambda at start rather than being ignored.
 */
export function readCommandAliases(env: Env): string[] {
  const value = env.LGTMOOSE_COMMAND_ALIASES?.trim() ?? "";
  if (value === "") return [];
  const aliases = value
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => alias !== "");
  for (const alias of aliases) {
    if (!GITHUB_LOGIN.test(alias)) {
      throw new Error("LGTMOOSE_COMMAND_ALIASES must be comma-separated GitHub logins.");
    }
  }
  if (aliases.length > 5) throw new Error("LGTMOOSE_COMMAND_ALIASES takes at most 5 aliases.");
  return aliases;
}

export function readReviewSettings(env: Env): ReviewSettings {
  const timeout = env.LGTMOOSE_BATCH_TIMEOUT_MS?.trim();
  const batchTimeoutMs = timeout ? Number(timeout) : DEFAULT_BATCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(batchTimeoutMs) || batchTimeoutMs <= 0) {
    throw new Error("LGTMOOSE_BATCH_TIMEOUT_MS must be a whole number of milliseconds.");
  }
  const judgements = env.LGTMOOSE_MAX_REPLY_JUDGEMENTS?.trim();
  const maxReplyJudgements = judgements ? Number(judgements) : DEFAULT_MAX_REPLY_JUDGEMENTS;
  if (!Number.isSafeInteger(maxReplyJudgements) || maxReplyJudgements < 0) {
    throw new Error("LGTMOOSE_MAX_REPLY_JUDGEMENTS must be a whole number.");
  }
  return {
    model: env.LGTMOOSE_REVIEWER_MODEL?.trim() ?? "",
    batchTimeoutMs,
    maxReplyJudgements,
    maxExplanations: readMaxExplanations(env),
    // Shadow mode is the safe side: only an explicit "false" posts to GitHub.
    shadow: env.LGTMOOSE_SHADOW?.trim() !== "false",
  };
}

/**
 * The most pending learnings one author may have in an org, from
 * `LGTMOOSE_MAX_PENDING_LEARNINGS` (`learnings.maxPendingPerAuthor`). Unset: the policy's default.
 */
export function readMaxPendingLearnings(env: Env): number | undefined {
  const value = env.LGTMOOSE_MAX_PENDING_LEARNINGS?.trim() ?? "";
  if (value === "") return undefined;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("LGTMOOSE_MAX_PENDING_LEARNINGS must be a whole number of at least 1.");
  }
  return limit;
}

/**
 * The cost cap of one bootstrap from review history, in USD, from
 * `LGTMOOSE_BOOTSTRAP_MAX_COST_USD` (`learnings.bootstrapMaxCostUsd`, NIC-1080). Unset: the default.
 */
export function readBootstrapMaxCost(env: Env): number | undefined {
  const value = env.LGTMOOSE_BOOTSTRAP_MAX_COST_USD?.trim() ?? "";
  if (value === "") return undefined;
  const cap = Number(value);
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error("LGTMOOSE_BOOTSTRAP_MAX_COST_USD must be a number of dollars, 0 or more.");
  }
  return cap;
}

/**
 * On how many PRs a pattern must be rejected before a learning is proposed, from
 * `LGTMOOSE_LEARNINGS_REPEAT_THRESHOLD` (`learnings.repeatThreshold`, NIC-1081). Unset: the
 * default, 2.
 */
export function readRepeatThreshold(env: Env): number | undefined {
  const value = env.LGTMOOSE_LEARNINGS_REPEAT_THRESHOLD?.trim() ?? "";
  if (value === "") return undefined;
  const threshold = Number(value);
  if (!Number.isSafeInteger(threshold) || threshold < 2) {
    throw new Error("LGTMOOSE_LEARNINGS_REPEAT_THRESHOLD must be a whole number of at least 2.");
  }
  return threshold;
}

/**
 * How learnings are ranked, from `LGTMOOSE_EMBEDDINGS` (`bedrock:<model>`, `openai:<model>`, or
 * `none` / unset for keywords) and, for OpenAI, `LGTMOOSE_EMBEDDINGS_SECRET_ID`, the key's
 * secret. The Workflow stack sets both from `learnings.embeddings`.
 */
export type EmbeddingsSettings =
  | { provider: "none" }
  | { provider: "bedrock"; model: string }
  | { provider: "openai"; model: string; secretArn: string };

export function readEmbeddingsSettings(env: Env): EmbeddingsSettings {
  const value = env.LGTMOOSE_EMBEDDINGS?.trim() ?? "";
  if (value === "" || value === "none") return { provider: "none" };
  const at = value.indexOf(":");
  const provider = at === -1 ? value : value.slice(0, at);
  const model = at === -1 ? "" : value.slice(at + 1).trim();
  if (model === "") throw new Error("LGTMOOSE_EMBEDDINGS needs a model: <provider>:<model>.");
  if (provider === "bedrock") return { provider, model };
  if (provider === "openai") {
    const secretArn = env.LGTMOOSE_EMBEDDINGS_SECRET_ID?.trim() ?? "";
    if (secretArn === "") {
      throw new Error("LGTMOOSE_EMBEDDINGS_SECRET_ID is needed for OpenAI embeddings.");
    }
    return { provider, model, secretArn };
  }
  throw new Error(`LGTMOOSE_EMBEDDINGS names an unknown provider: ${provider}.`);
}

/**
 * Ticket coverage (NIC-839), from `LGTMOOSE_TICKETS` (`linear`, or `none` / unset for off),
 * `LGTMOOSE_TICKETS_SECRET_ID` (the provider's API key's secret), `LGTMOOSE_TICKETS_MAX` (the
 * most tickets checked per PR) and `LGTMOOSE_TICKETS_TEAMS` (comma-separated team keys; empty
 * for any). The Workflow stack sets them from `tickets` in the deploy config.
 */
export type TicketSettings =
  | { provider: "none" }
  | {
      provider: "linear";
      secretArn: string;
      maxPerPullRequest: number;
      teamKeys: string[];
      /** `LGTMOOSE_TICKETS_PUBLIC_DETAILS=true`: show ticket text on public repositories too. */
      detailsOnPublicRepos: boolean;
    };

export function readTicketSettings(env: Env): TicketSettings {
  const provider = env.LGTMOOSE_TICKETS?.trim() ?? "";
  if (provider === "" || provider === "none") return { provider: "none" };
  if (provider !== "linear") {
    throw new Error(`LGTMOOSE_TICKETS names an unknown provider: ${provider}.`);
  }
  const secretArn = env.LGTMOOSE_TICKETS_SECRET_ID?.trim() ?? "";
  if (secretArn === "") throw new Error("LGTMOOSE_TICKETS_SECRET_ID is needed for Linear.");
  const max = Number(env.LGTMOOSE_TICKETS_MAX?.trim() || "3");
  if (!Number.isSafeInteger(max) || max < 0 || max > 10) {
    throw new Error("LGTMOOSE_TICKETS_MAX must be a whole number from 0 to 10.");
  }
  const teamKeys = (env.LGTMOOSE_TICKETS_TEAMS ?? "")
    .split(",")
    .map((team) => team.trim().toUpperCase())
    .filter((team) => team !== "");
  return {
    provider,
    secretArn,
    maxPerPullRequest: max,
    teamKeys,
    detailsOnPublicRepos: env.LGTMOOSE_TICKETS_PUBLIC_DETAILS?.trim() === "true",
  };
}

/**
 * One step of the review workflow, from the variables the state machine sets per task
 * (container overrides). Each names the execution, so the run can be found and failed.
 */
export type ControlCommand =
  | { command: "prepare"; executionArn: string; job: string; taskToken: string }
  | {
      command: "post";
      executionArn: string;
      runId: string;
      taskToken: string;
      /** Which attempt of the post step this is, of how many: unset when not told. */
      attempt?: { number: number; of: number };
    }
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
    case "post": {
      const count = (name: string) => {
        const value = env[name]?.trim();
        return value !== undefined && /^\d{1,4}$/.test(value) ? Number(value) : undefined;
      };
      const retry = count("LGTMOOSE_POST_RETRY");
      const of = count("LGTMOOSE_POST_ATTEMPTS");
      return {
        command,
        executionArn,
        runId: need("LGTMOOSE_RUN_ID"),
        taskToken: need("LGTMOOSE_TASK_TOKEN"),
        ...(retry === undefined || of === undefined || of === 0
          ? {}
          : { attempt: { number: retry + 1, of } }),
      };
    }
    case "fail":
      return { command, executionArn, error: env.LGTMOOSE_ERROR?.trim() || "unknown error" };
    default:
      throw new Error(`Unknown LGTMOOSE_COMMAND ${JSON.stringify(command.slice(0, 40))}.`);
  }
}
