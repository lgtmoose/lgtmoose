import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { FEEDBACK_REPORT_KEY, SECRET_NAMES, fetchStatus, planModelChecks } from "@lgtmoose/config";
import {
  ensureDashboardRole,
  ensureGatewayRole,
  PostgresQueue,
  postgresArtifactStore,
  postgresExecutions,
  postgresRunners,
  postgresSpend,
  runExclusive,
  STALE_RESERVATION_MS,
} from "@lgtmoose/db";
import { MIGRATIONS_FOLDER, runMigrations } from "@lgtmoose/db/migrate";
import { drizzleLearningStore, retireUnusedLearnings } from "@lgtmoose/learnings";
import { appJwt, GitHubClient, installationTokenProvider } from "@lgtmoose/poster";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { z } from "zod";
import { controlDepsFor } from "../aws.js";
import { drizzleBootstrapStore } from "../bootstrap-store.js";
import { drizzleConversationStore, githubConversation } from "../conversation-aws.js";
import { conversationBatch } from "../conversation-lambda.js";
import { checkCredentials } from "../credentials.js";
import { reportModel, reportProblem } from "../credentials-aws.js";
import { healthCheck } from "../model-health.js";
import { drizzleChecksWaits, drizzleDispatchStore } from "../dispatch-aws.js";
import { collectFeedback } from "../feedback.js";
import { drizzleFeedbackStore, githubFeedback } from "../feedback-aws.js";
import { learnFromAnswers } from "../finding-answers.js";
import { drizzleAnswerLearningStore } from "../outcome-learning-aws.js";
import { embedderFor } from "../learnings.js";
import { log } from "../log.js";
import { metricsLine, reconcile } from "../reconcile.js";
import { drizzleReconcileStore, githubReconcile } from "../reconcile-aws.js";
import { settleStaleSpend } from "../spend.js";
import { drizzleReplyStore } from "../replies-aws.js";
import { ticketSourceFor } from "../tickets.js";
import { Docker, socketTransport } from "./docker.js";
import { DEAD_QUEUE, JOBS_QUEUE, createRunner } from "./runner.js";
import { dockerBatchRunner, removeStrandedSandboxes } from "./sandbox.js";
import { fileCredentialSecrets, readSecretFile } from "./secrets.js";
import { consumeConversations, every, queueSender, sweep } from "./services.js";
import { checkEgressHosts, readLocalSettings } from "./settings.js";

/**
 * The docker compose runner (NIC-843): one long-running process that does what the dispatcher
 * Lambda, the review state machine, the control and sandbox tasks, the conversation Lambda and
 * the scheduled Lambdas do on AWS, over Postgres and the Docker socket. Several may run against
 * one database (NIC-1056): each beats in `local_runners`, cleans up only after runners whose
 * heartbeat is stale, and runs each scheduled job only while it holds that job's advisory lock.
 */

const CONVERSATION_QUEUE = "conversation";
const GITHUB_TIMEOUT_MS = 30_000;
const TICK_MS = 1_000;
/** How often a runner beats. LGTMOOSE_RUNNER_STALE_SECONDS must be well above it. */
const HEARTBEAT_MS = 10_000;
/** How often a runner looks for runners that stopped, to fail their runs. */
const RECOVER_MS = 60_000;

const appSecretSchema = z.object({
  appId: z.coerce.number().int().positive(),
  privateKey: z.string().min(1),
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} must be set.`);
  return value;
}

function whole(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const secretsDir = process.env.LGTMOOSE_SECRETS_DIR?.trim() || "/run/lgtmoose/secrets";
  const settings = await readLocalSettings(
    process.env.LGTMOOSE_CONFIG?.trim() || "/config/lgtmoose.config.json",
  );
  const { config } = settings;
  checkEgressHosts(config, process.env.LGTMOOSE_EGRESS_HOSTS);

  // The schema first, then the gateway's login, which can only add jobs.
  await runMigrations({ connectionString: databaseUrl, migrationsFolder: MIGRATIONS_FOLDER });
  // And the dashboard's, which reads reviews and changes only sessions and learnings' status.
  const gatewayPassword = process.env.LGTMOOSE_GATEWAY_DB_PASSWORD?.trim();
  const dashboardPassword = process.env.LGTMOOSE_DASHBOARD_DB_PASSWORD?.trim();
  {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      // Runners starting together would race on `create role`: one at a time.
      await client.query("select pg_advisory_lock(hashtextextended('lgtmoose:roles', 0))");
      if (gatewayPassword !== undefined && gatewayPassword !== "") {
        await ensureGatewayRole(client, gatewayPassword);
      }
      if (dashboardPassword !== undefined && dashboardPassword !== "") {
        await ensureDashboardRole(client, dashboardPassword, { reportKey: FEEDBACK_REPORT_KEY });
      }
    } finally {
      await client.end();
    }
  }
  const staleMs = whole("LGTMOOSE_RUNNER_STALE_SECONDS", 120, 45, 3600) * 1000;

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on("error", (error) => log("database connection dropped", { error: error.message }));
  const db = drizzle({ client: pool });
  const store = postgresArtifactStore(db);
  const executions = postgresExecutions(db);
  const runners = postgresRunners(db);
  const jobs = new PostgresQueue(db, JOBS_QUEUE);
  const dead = new PostgresQueue(db, DEAD_QUEUE);
  const conversations = new PostgresQueue(db, CONVERSATION_QUEUE);

  const secret = async (name: string) => {
    const value = await readSecretFile(secretsDir, name);
    if (value === undefined) throw new Error(`No ${name} in the secrets directory.`);
    return value;
  };
  const app = appSecretSchema.parse(JSON.parse(await secret(SECRET_NAMES.githubApp)));
  const embedder = await embedderFor(settings.embeddings, {
    bedrock: () => {
      throw new Error("Bedrock embeddings need AWS.");
    },
    secret,
  });
  const tickets = ticketSourceFor(settings.tickets, secret);
  const control = controlDepsFor({
    app,
    db,
    store,
    // Prepare and post report back to Step Functions only on AWS.
    tokens: { succeed: async () => undefined, fail: async () => undefined },
    shadow: config.shadow,
    embedder,
    ...(tickets === undefined ? {} : { tickets }),
    maxPendingLearnings: config.learnings.maxPendingPerAuthor,
    bootstrapMaxCostUsd: config.learnings.bootstrapMaxCostUsd,
    repeatThreshold: config.learnings.repeatThreshold,
    budgets: config.budgets,
    commandAliases: config.commandAliases,
  });

  const docker = new Docker(
    socketTransport(process.env.DOCKER_SOCKET?.trim() || "/var/run/docker.sock"),
  );
  const network = process.env.LGTMOOSE_SANDBOX_NETWORK?.trim() || "lgtmoose-sandbox";
  if (!(await docker.networkExists(network))) {
    throw new Error(
      `The sandbox network ${network} doesn't exist: start the runner with docker compose.`,
    );
  }
  const owner = `runner-${randomUUID()}`;
  const host = hostname();
  await runners.register(owner, host);
  // Sandboxes runners that have stopped left behind; never a live runner's.
  await removeStrandedSandboxes(docker, owner, await runners.live(staleMs));

  const secrets = fileCredentialSecrets(secretsDir);
  const runBatch = dockerBatchRunner({
    docker,
    store,
    secrets,
    providers: settings.providers,
    image: required("LGTMOOSE_SANDBOX_IMAGE"),
    network,
    runnerId: owner,
    proxyUrl: process.env.LGTMOOSE_PROXY_URL?.trim() || "http://egress-proxy:3128",
    timeoutMs: 30 * 60_000,
    memoryBytes: whole("LGTMOOSE_SANDBOX_MEMORY_MB", 4096, 512, 65_536) * 1024 * 1024,
    cpus: whole("LGTMOOSE_SANDBOX_CPUS", 2, 0.5, 64),
    leaseWaitMs: 3 * 60 * 60_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    broker: {
      store,
      executionRunning: async (arn) => (await executions.status(arn)) === "RUNNING",
      leaseTtlMs: 40 * 60_000,
      now: Date.now,
      newToken: () => randomBytes(16).toString("hex"),
      random: Math.random,
      audit: (event, fields) => log(event, { audit: true, ...fields }),
      problem: reportProblem,
    },
  });
  const sender = queueSender(jobs);
  const runner = createRunner({
    jobs,
    dead,
    executions,
    dispatchStore: drizzleDispatchStore(db),
    checksWaits: drizzleChecksWaits(db),
    conversation: queueSender(conversations),
    pushDebounceSeconds: config.reviewDebounceSeconds,
    workflow: {
      control,
      runBatch,
      settings: {
        model: settings.reviewerModel,
        batchTimeoutMs: 20 * 60_000,
        maxReplyJudgements: config.maxReplyJudgements,
        maxExplanations: config.maxExplanations,
      },
      maxConcurrency: config.maxConcurrency,
      runnerAlive: async (id) => (await runners.live(staleMs)).has(id),
      attempts: 3,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    owner,
    staleMs,
    maxExecutions: whole("LGTMOOSE_MAX_EXECUTIONS", 2, 1, 32),
    log,
  });

  // What the conversation Lambda does on AWS.
  let slugOnce: Promise<string> | undefined;
  const slug = () => {
    slugOnce ??= new GitHubClient({
      token: async () => appJwt(app.appId, app.privateKey),
      timeoutMs: GITHUB_TIMEOUT_MS,
    })
      .request<{ slug?: unknown }>("GET", "/app")
      .then((reply) => {
        if (typeof reply.slug !== "string") throw new Error("GET /app returned no slug.");
        return reply.slug;
      });
    slugOnce.catch(() => {
      slugOnce = undefined;
    });
    return slugOnce;
  };
  const conversationDeps = {
    async github(installationId: number) {
      const token = installationTokenProvider({
        ...app,
        installationId,
        timeoutMs: GITHUB_TIMEOUT_MS,
      });
      return githubConversation(
        new GitHubClient({ token, timeoutMs: GITHUB_TIMEOUT_MS }),
        slug,
        log,
      );
    },
    store: drizzleConversationStore(db),
    learnings: drizzleLearningStore(db),
    maxPendingLearnings: config.learnings.maxPendingPerAuthor,
    // An `ignore` may complete a repeated rejection (NIC-1081).
    ...(control.outcomes === undefined ? {} : { outcomes: control.outcomes }),
    replies: drizzleReplyStore(db),
    maxExplanations: config.maxExplanations,
    commandAliases: config.commandAliases,
    commandHint: config.commandHint,
    queue: sender,
    shadow: config.shadow,
    log,
  };

  // The scheduled Lambdas.
  const reconcileDeps = {
    github: githubReconcile(app, { timeoutMs: GITHUB_TIMEOUT_MS }),
    store: drizzleReconcileStore(db),
    queue: {
      send: (
        job: Parameters<typeof sender.sendWith>[0],
        options: { groupId: string; dedupeId: string },
      ) => sender.sendWith(job, options),
    },
    allowedOrgs: config.allowedOrgs,
    shadow: config.shadow,
    lookbackMs: config.reconcileLookbackHours * 3_600_000,
    log,
    // Bootstraps from review history (NIC-1080), asked for on the dashboard, run as executions
    // of the runner's workflow like reviews.
    bootstraps: {
      store: drizzleBootstrapStore(db),
      async startExecution(name: string, input: unknown) {
        await executions.start(name, input);
        return executions.arnOf(name);
      },
      maxCostUsd: config.learnings.bootstrapMaxCostUsd,
    },
  };
  const reconcileOnce = async () => {
    const counts = await reconcile(reconcileDeps);
    counts.learningsRetired = await retireUnusedLearnings(drizzleLearningStore(db));
    const feedback = await collectFeedback({
      store: drizzleFeedbackStore(db),
      github: githubFeedback(app, { timeoutMs: GITHUB_TIMEOUT_MS }),
      putReport: (key, body) => store.putText(key, body),
      log,
      maxComments: config.feedback.maxCommentsPerRun,
      threshold: config.feedback.acceptanceThreshold,
      minSamples: config.feedback.minSamples,
      // A comment newly 👎'd may complete a repeated rejection (NIC-1081).
      onRejected: (comment) =>
        control.outcomes?.rejected(comment.installationId, comment.repo, [
          { findingId: comment.findingId },
        ]) ?? Promise.resolve(),
    });
    counts.feedbackCommentsRead = feedback.feedbackCommentsRead;
    counts.categoriesFlagged = feedback.categoriesFlagged;
    counts.errors += feedback.errors;
    // Findings declined from the CLI or the dashboard (NIC-1140): outcome learning.
    const outcomes = control.outcomes;
    if (outcomes !== undefined) {
      await learnFromAnswers({
        store: drizzleAnswerLearningStore(db),
        rejected: (installationId, repo, rejected) =>
          outcomes.rejectedResults?.(installationId, repo, rejected) ??
          outcomes.rejected(installationId, repo, rejected),
        log,
      }).catch((error: unknown) => {
        counts.errors += 1;
        log("reconcile: answers not learned from", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // Spend caps (NIC-1079): settle runs post never reached, from their batches' outputs.
    await settleStaleSpend(
      { store: postgresSpend(db), budgets: config.budgets },
      store,
      new Date(),
      log,
      STALE_RESERVATION_MS,
    );
    process.stdout.write(`${metricsLine(counts, new Date())}\n`);
  };
  // The runner holds every provider's key already, so it checks API-key models too (NIC-1121).
  const modelChecks = planModelChecks(config).checks;
  // Compose refuses Bedrock providers (`localSettings`), so there's never a Bedrock model here.
  const health = () =>
    healthCheck({
      credentials: () =>
        checkCredentials({
          secrets,
          credentials: Object.fromEntries(
            settings.providers.flatMap((provider) =>
              provider.credential === undefined
                ? []
                : [[provider.id, { ...provider.credential, auth: provider.auth }]],
            ),
          ),
          now: Date.now,
          problem: reportProblem,
        }),
      checks: () => modelChecks,
      region: config.region,
      bedrock: () => Promise.reject(new Error("docker compose has no Bedrock providers")),
      api: {
        get: fetchStatus,
        key: async (providerId) => {
          const secretId = settings.providers.find((p) => p.id === providerId)?.credential
            ?.secretId;
          return secretId === undefined ? undefined : secrets.read(secretId);
        },
      },
      report: reportModel,
      log,
    });

  await runner.recover();
  log("runner started", {
    owner,
    host,
    providers: settings.providers.map((provider) => provider.id),
  });

  /**
   * A scheduled job, run by one runner at a time and about once per interval between them all:
   * each runner's timer fires every `intervalMs`, and the job runs only where the lock is free
   * and it hasn't run for half an interval.
   */
  const scheduled = (
    name: string,
    intervalMs: number,
    task: () => Promise<unknown>,
    firstAfterMs: number,
  ) =>
    every(
      name,
      intervalMs,
      () => runExclusive(pool, name, intervalMs / 2, task),
      log,
      firstAfterMs,
    );
  const stops = [
    every("heartbeat", HEARTBEAT_MS, () => runners.heartbeat(owner, host), log),
    every(
      "recovery",
      RECOVER_MS,
      async () => {
        await runner.recover();
        await removeStrandedSandboxes(docker, owner, await runners.live(staleMs));
        await runners.pruneStale(staleMs);
      },
      log,
    ),
    scheduled("reconcile", config.reconcileIntervalMinutes * 60_000, reconcileOnce, 60_000),
    scheduled("credential health", 6 * 3_600_000, health, 30_000),
    scheduled(
      "retention sweep",
      24 * 3_600_000,
      async () =>
        log(
          "swept",
          await sweep({ artifacts: store, executions, queues: [jobs, dead, conversations] }),
        ),
      5 * 60_000,
    ),
  ];

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { signal });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));

  while (!stopping) {
    try {
      await runner.tick();
      await consumeConversations(conversations, (records) =>
        conversationBatch(conversationDeps, records),
      );
    } catch (error) {
      log("tick failed", { error: error instanceof Error ? error.message : String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
  await Promise.all(stops.map((stopTask) => stopTask()));
  // Running reviews finish; another runner, or a later start, fails what doesn't (`recover`).
  await runner.idle();
  await runners.remove(owner);
  await pool.end();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
