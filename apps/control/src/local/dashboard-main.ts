import { SECRET_NAMES } from "@lgtmoose/config";
import { drizzleLearningStore } from "@lgtmoose/learnings";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { z } from "zod";
import { handleDashboardRequest, type DashboardDeps } from "../dashboard.js";
import { githubDashboard } from "../dashboard-github.js";
import { json } from "../dashboard-http.js";
import { drizzleDashboardStore } from "../dashboard-store.js";
import { BOOTSTRAP_DEFAULTS } from "../bootstrap.js";
import { drizzleBootstrapStore } from "../bootstrap-store.js";
import { log } from "../log.js";
import { createDashboardServer, readSite } from "./dashboard-server.js";
import { parseOrigin, signingKey, viewFeedbackReport } from "./dashboard-setup.js";
import { readSecretFile } from "./secrets.js";

/**
 * The dashboard service under docker compose (NIC-1056): the page and the dashboard API on one
 * origin, as on AWS. It holds a database login that reads reviews and changes only sessions and
 * learnings' status (`ensureDashboardRole`), the App's OAuth client and its own signing key, in a
 * secrets directory of its own: never the App's private key, the webhook secret, a model
 * credential or the Docker socket.
 *
 * DATABASE_URL: the `lgtmoose_dashboard` login the runner creates.
 * DASHBOARD_ORIGIN: `https://<host>`, where people open it; the OAuth callback is
 *   `<origin>/api/auth/callback`, and writes must come from this origin.
 * ALLOWED_ORGS: who may sign in, as the gateway's.
 * TRUST_PROXY_HOPS: proxies in front that append to X-Forwarded-For (default 0).
 * LGTMOOSE_SECRETS_DIR: the dashboard's secrets directory (default /run/lgtmoose/secrets).
 * LGTMOOSE_SITE_DIR: the built page (default /app/site). PORT: where to listen (default 3001).
 */

const oauthSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} must be set.`);
  return value;
}

function whole(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

async function main(): Promise<void> {
  const origin = parseOrigin(required("DASHBOARD_ORIGIN"));
  const allowedOrgs = required("ALLOWED_ORGS")
    .split(",")
    .map((org) => org.trim())
    .filter((org) => org !== "");
  if (allowedOrgs.length === 0) throw new Error("ALLOWED_ORGS must name an org.");
  const secretsDir = process.env.LGTMOOSE_SECRETS_DIR?.trim() || "/run/lgtmoose/secrets";
  const port = whole("PORT", 3001, 1, 65_535);
  const trustProxyHops = whole("TRUST_PROXY_HOPS", 0, 0, 10);
  const site = await readSite(process.env.LGTMOOSE_SITE_DIR?.trim() || "/app/site");
  const key = await signingKey(secretsDir);

  const databaseUrl = required("DATABASE_URL");
  if (new URL(databaseUrl).password === "") {
    throw new Error("The dashboard's database login has no password: set DASHBOARD_DB_PASSWORD.");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  pool.on("error", (error) => log("database connection dropped", { error: error.message }));
  const db = drizzle({ client: pool });

  const deps: DashboardDeps = {
    store: drizzleDashboardStore(db),
    learnings: drizzleLearningStore(db),
    bootstraps: { store: drizzleBootstrapStore(db), maxPrs: BOOTSTRAP_DEFAULTS.maxPrs },
    feedbackReport: viewFeedbackReport(pool),
    github: githubDashboard({ timeoutMs: 8000 }),
    // Read on each sign-in until it's there, so storing it later needs no restart.
    async oauthClient() {
      try {
        const value = await readSecretFile(secretsDir, SECRET_NAMES.githubAppOAuth);
        if (value === undefined) return undefined;
        const parsed = oauthSchema.safeParse(JSON.parse(value));
        if (!parsed.success) throw new Error("The OAuth client file is missing fields.");
        return parsed.data;
      } catch (error) {
        log("dashboard OAuth client unread", {
          error: error instanceof Error ? error.message : "error",
        });
        return undefined;
      }
    },
    signingKey: async () => key,
    origin: async () => origin,
    allowedOrgs,
    now: () => new Date(),
    log,
  };

  const server = createDashboardServer({
    async handle(request) {
      try {
        return await handleDashboardRequest(deps, request);
      } catch (error) {
        log("dashboard request failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return json(500, { error: "internal" });
      }
    },
    site,
    trustProxyHops,
    log,
  });
  server.listen(port, () => log("dashboard listening", { port, origin }));

  const stop = (signal: string) => {
    log("stopping", { signal });
    server.close(() => {
      pool.end().catch(() => undefined);
    });
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
