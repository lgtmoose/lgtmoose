import { dashboardSessions, findings, providerUsage, pullRequests, reviewRuns } from "@lgtmoose/db";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "./database.js";

/**
 * The dashboard's reads and its sessions (NIC-840). Every read takes the repositories the
 * signed-in person can see (lowercased owner/name) and returns nothing outside them.
 */

export interface DashboardSession {
  login: string;
  orgs: string[];
  repos: string[];
  expiresAt: Date;
}

export interface RepoSummary {
  repo: string;
  openFindings: number;
  blocking: number;
  /** When the newest review run of the repository's PRs started; undefined without one. */
  lastRunAt: string | undefined;
}

export interface OpenFinding {
  id: string;
  repo: string;
  number: number;
  severity: "blocking" | "should_fix" | "nit";
  ruleCategory: string;
  title: string;
  body: string;
  path: string | undefined;
  line: number | undefined;
  /** Who raised it: LGTMoose, or another reviewer's login. */
  source: "self" | "bot" | "human";
  sourceLogin: string | undefined;
  createdAt: string;
}

export interface RunSummary {
  id: string;
  repo: string;
  number: number;
  headSha: string;
  kind: string;
  status: string;
  costUsd: number | undefined;
  filesDone: number;
  filesTotal: number | undefined;
  /** Providers that ran batches of it, as recorded in `provider_usage`. */
  providers: string[];
  startedAt: string | undefined;
  finishedAt: string | undefined;
  createdAt: string;
}

export interface DashboardStore {
  createSession(tokenHash: string, session: DashboardSession): Promise<void>;
  /** The session for a token hash, while it hasn't expired. */
  session(tokenHash: string, now: Date): Promise<DashboardSession | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Removes sessions that have ended. */
  deleteExpired(now: Date): Promise<number>;
  repoSummaries(repos: readonly string[]): Promise<RepoSummary[]>;
  /** Open findings in `repos`, most severe first, at most `limit`. */
  openFindings(repos: readonly string[], limit: number): Promise<OpenFinding[]>;
  /** The newest review runs in `repos`, at most `limit`. */
  recentRuns(repos: readonly string[], limit: number): Promise<RunSummary[]>;
}

const SEVERITY_ORDER = sql`case ${findings.severity} when 'blocking' then 0 when 'should_fix' then 1 else 2 end`;

const iso = (value: Date | null): string | undefined => value?.toISOString();

export function drizzleDashboardStore(db: Db): DashboardStore {
  const inRepos = (repos: readonly string[]) =>
    inArray(sql`lower(${pullRequests.repo})`, [...repos]);
  return {
    async createSession(tokenHash, session) {
      await db.insert(dashboardSessions).values({ tokenHash, ...session });
    },
    async session(tokenHash, now) {
      const [row] = await db
        .select()
        .from(dashboardSessions)
        .where(
          and(eq(dashboardSessions.tokenHash, tokenHash), gt(dashboardSessions.expiresAt, now)),
        )
        .limit(1);
      return row === undefined
        ? undefined
        : { login: row.login, orgs: row.orgs, repos: row.repos, expiresAt: row.expiresAt };
    },
    async deleteSession(tokenHash) {
      await db.delete(dashboardSessions).where(eq(dashboardSessions.tokenHash, tokenHash));
    },
    async deleteExpired(now) {
      const removed = await db
        .delete(dashboardSessions)
        .where(lt(dashboardSessions.expiresAt, now))
        .returning({ tokenHash: dashboardSessions.tokenHash });
      return removed.length;
    },
    async repoSummaries(repos) {
      if (repos.length === 0) return [];
      const repo = sql<string>`lower(${pullRequests.repo})`;
      const counts = await db
        .select({
          repo,
          openFindings: sql<number>`count(${findings.id}) filter (where ${findings.status} = 'open')`,
          blocking: sql<number>`count(${findings.id}) filter (where ${findings.status} = 'open' and ${findings.severity} = 'blocking')`,
        })
        .from(pullRequests)
        .leftJoin(findings, eq(findings.pullRequestId, pullRequests.id))
        .where(inRepos(repos))
        .groupBy(repo);
      const lastRuns = await db
        .select({ repo, lastRunAt: sql<string | null>`max(${reviewRuns.createdAt})` })
        .from(reviewRuns)
        .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
        .where(inRepos(repos))
        .groupBy(repo);
      const last = new Map(lastRuns.map((row) => [row.repo, row.lastRunAt]));
      return counts
        .map((row) => {
          const at = last.get(row.repo);
          return {
            repo: row.repo,
            openFindings: Number(row.openFindings),
            blocking: Number(row.blocking),
            lastRunAt: at === null || at === undefined ? undefined : new Date(at).toISOString(),
          };
        })
        .sort((a, b) => a.repo.localeCompare(b.repo));
    },
    async openFindings(repos, limit) {
      if (repos.length === 0) return [];
      const rows = await db
        .select({
          id: findings.id,
          repo: sql<string>`lower(${pullRequests.repo})`,
          number: pullRequests.number,
          severity: findings.severity,
          ruleCategory: findings.ruleCategory,
          title: findings.title,
          body: findings.body,
          path: findings.path,
          line: findings.line,
          source: findings.source,
          sourceLogin: findings.sourceLogin,
          createdAt: findings.createdAt,
        })
        .from(findings)
        .innerJoin(pullRequests, eq(findings.pullRequestId, pullRequests.id))
        .where(and(eq(findings.status, "open"), inRepos(repos)))
        .orderBy(SEVERITY_ORDER, desc(findings.createdAt))
        .limit(limit);
      return rows.map((row) => ({
        ...row,
        path: row.path ?? undefined,
        line: row.line ?? undefined,
        sourceLogin: row.sourceLogin ?? undefined,
        createdAt: row.createdAt.toISOString(),
      }));
    },
    async recentRuns(repos, limit) {
      if (repos.length === 0) return [];
      const rows = await db
        .select({
          id: reviewRuns.id,
          repo: sql<string>`lower(${pullRequests.repo})`,
          number: pullRequests.number,
          headSha: reviewRuns.headSha,
          kind: reviewRuns.kind,
          status: reviewRuns.status,
          costUsd: reviewRuns.costUsd,
          filesDone: reviewRuns.filesDone,
          filesTotal: reviewRuns.filesTotal,
          startedAt: reviewRuns.startedAt,
          finishedAt: reviewRuns.finishedAt,
          createdAt: reviewRuns.createdAt,
        })
        .from(reviewRuns)
        .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
        .where(inRepos(repos))
        .orderBy(desc(reviewRuns.createdAt))
        .limit(limit);
      const providers = new Map<string, Set<string>>();
      if (rows.length > 0) {
        const usage = await db
          .selectDistinct({ runId: providerUsage.runId, providerId: providerUsage.providerId })
          .from(providerUsage)
          .where(
            inArray(
              providerUsage.runId,
              rows.map((row) => row.id),
            ),
          );
        for (const row of usage) {
          const set = providers.get(row.runId) ?? new Set<string>();
          set.add(row.providerId);
          providers.set(row.runId, set);
        }
      }
      return rows.map((row) => ({
        id: row.id,
        repo: row.repo,
        number: row.number,
        headSha: row.headSha,
        kind: row.kind,
        status: row.status,
        costUsd: row.costUsd === null ? undefined : Number(row.costUsd),
        filesDone: row.filesDone,
        filesTotal: row.filesTotal ?? undefined,
        providers: [...(providers.get(row.id) ?? [])].sort(),
        startedAt: iso(row.startedAt),
        finishedAt: iso(row.finishedAt),
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };
}
