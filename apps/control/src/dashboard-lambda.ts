import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { FEEDBACK_REPORT_KEY } from "@lgtmoose/config";
import { drizzleLearningStore } from "@lgtmoose/learnings";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { handleDashboardRequest, type DashboardDeps } from "./dashboard.js";
import { githubDashboard } from "./dashboard-github.js";
import {
  fromHttpApiEvent,
  json,
  throughCloudFront,
  toHttpApiResult,
  type HttpApiEvent,
} from "./dashboard-http.js";
import { drizzleDashboardStore } from "./dashboard-store.js";
import { BOOTSTRAP_DEFAULTS } from "./bootstrap.js";
import { drizzleBootstrapStore } from "./bootstrap-store.js";
import { readBudgets } from "./spend.js";
import { databasePool, parseSecret, readSecret } from "./database.js";
import { log } from "./log.js";

/**
 * The dashboard API Lambda (NIC-840), behind its own HTTP API and the dashboard's CloudFront
 * distribution. It holds the database, the App's OAuth client, a signing key and read access to
 * the feedback report: never the App's private key, the webhook secret or a model credential.
 */

const REQUIRED = [
  "DATABASE_SECRET_ARN",
  "DATABASE_NAME",
  "OAUTH_SECRET_ID",
  "SIGNING_KEY_SECRET_ARN",
  "ORIGIN_SECRET_ARN",
  "ORIGIN_PARAMETER_NAME",
  "ALLOWED_ORGS",
  "ARTIFACT_BUCKET",
] as const;

export interface DashboardEnv {
  databaseSecretArn: string;
  databaseName: string;
  oauthSecretId: string;
  signingKeySecretArn: string;
  /** The secret CloudFront sends in `DASHBOARD_ORIGIN_HEADER` (NIC-1140). */
  originSecretArn: string;
  originParameterName: string;
  allowedOrgs: string[];
  /** Where the feedback report is (`FEEDBACK_REPORT_KEY`); the Lambda may read that key only. */
  artifactBucket: string;
}

export function readDashboardEnv(
  env: Record<string, string | undefined>,
): DashboardEnv | { missing: string[] } {
  const missing = REQUIRED.filter((name) => (env[name] ?? "").trim() === "");
  const allowedOrgs = (env.ALLOWED_ORGS ?? "")
    .split(",")
    .map((org) => org.trim())
    .filter((org) => org !== "");
  if (missing.length > 0 || allowedOrgs.length === 0) {
    return { missing: missing.length > 0 ? [...missing] : ["ALLOWED_ORGS"] };
  }
  const value = (name: (typeof REQUIRED)[number]) => (env[name] ?? "").trim();
  return {
    databaseSecretArn: value("DATABASE_SECRET_ARN"),
    databaseName: value("DATABASE_NAME"),
    oauthSecretId: value("OAUTH_SECRET_ID"),
    signingKeySecretArn: value("SIGNING_KEY_SECRET_ARN"),
    originSecretArn: value("ORIGIN_SECRET_ARN"),
    originParameterName: value("ORIGIN_PARAMETER_NAME"),
    allowedOrgs,
    artifactBucket: value("ARTIFACT_BUCKET"),
  };
}

const oauthSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

/** Read once per container, and again after a failure (the secret may be stored later). */
function cached<T>(read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= read().catch((error: unknown) => {
      value = undefined;
      throw error;
    });
    return value;
  };
}

let deps: Promise<DashboardDeps & { originSecret(): Promise<string> }> | undefined;

function dashboardDeps(): Promise<DashboardDeps & { originSecret(): Promise<string> }> {
  deps ??= (async () => {
    const env = readDashboardEnv(process.env);
    if ("missing" in env) {
      throw new Error(`Missing environment variables: ${env.missing.join(", ")}`);
    }
    const secrets = new SecretsManagerClient({});
    const ssm = new SSMClient({});
    const s3 = new S3Client({});
    const pool = await databasePool(secrets, env.databaseSecretArn, env.databaseName, 2);
    pool.on("error", (error) => log("database connection dropped", { error: error.message }));
    let oauth: { clientId: string; clientSecret: string } | undefined;
    const db = drizzle({ client: pool });
    return {
      store: drizzleDashboardStore(db),
      learnings: drizzleLearningStore(db),
      bootstraps: { store: drizzleBootstrapStore(db), maxPrs: BOOTSTRAP_DEFAULTS.maxPrs },
      async feedbackReport() {
        try {
          const object = await s3.send(
            new GetObjectCommand({ Bucket: env.artifactBucket, Key: FEEDBACK_REPORT_KEY }),
          );
          const text = await object.Body?.transformToString("utf8");
          return text === undefined ? undefined : (JSON.parse(text) as unknown);
        } catch (error) {
          // No report until the reconciler has written one.
          if (error instanceof NoSuchKey) return undefined;
          throw error;
        }
      },
      github: githubDashboard({ timeoutMs: 8000 }),
      budgets: readBudgets(process.env),
      async oauthClient() {
        if (oauth !== undefined) return oauth;
        try {
          oauth = parseSecret(oauthSchema, await readSecret(secrets, env.oauthSecretId), "OAuth");
          return oauth;
        } catch (error) {
          // Not stored yet: sign-in says so, and the next request looks again.
          log("dashboard OAuth client unread", {
            error: error instanceof Error ? error.name : "error",
          });
          return undefined;
        }
      },
      signingKey: cached(async () => {
        const { SecretString } = await secrets.send(
          new GetSecretValueCommand({ SecretId: env.signingKeySecretArn }),
        );
        if (!SecretString || SecretString.length < 32) {
          throw new Error("The dashboard signing key is missing or too short.");
        }
        return Buffer.from(SecretString, "utf8");
      }),
      origin: cached(async () => {
        const { Parameter } = await ssm.send(
          new GetParameterCommand({ Name: env.originParameterName }),
        );
        const value = Parameter?.Value ?? "";
        if (!/^https:\/\/[a-z0-9.-]+$/i.test(value)) {
          throw new Error("The dashboard origin parameter isn't an https origin.");
        }
        return value;
      }),
      allowedOrgs: env.allowedOrgs,
      originSecret: cached(async () => {
        const { SecretString } = await secrets.send(
          new GetSecretValueCommand({ SecretId: env.originSecretArn }),
        );
        if (!SecretString || SecretString.length < 32) {
          throw new Error("The dashboard origin secret is missing or too short.");
        }
        return SecretString;
      }),
      now: () => new Date(),
      log,
    };
  })().catch((error: unknown) => {
    deps = undefined;
    throw error;
  });
  return deps;
}

export async function handler(event: HttpApiEvent) {
  try {
    const ready = await dashboardDeps();
    // Only through CloudFront (NIC-1140): the API's own URL answers nothing, and the secret
    // header is taken off before anything else reads the request.
    const request = throughCloudFront(fromHttpApiEvent(event), await ready.originSecret());
    if (request === undefined) return toHttpApiResult(json(403, { error: "forbidden" }));
    return toHttpApiResult(await handleDashboardRequest(ready, request));
  } catch (error) {
    log("dashboard request failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpApiResult(json(500, { error: "internal" }));
  }
}
