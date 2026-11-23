import {
  dashboardSessions,
  findings,
  postgresSpend,
  providerCooldowns,
  providerUsage,
  pullRequests,
  reviewRuns,
} from "@lgtmoose/db";
import { MAX_DECLINE_REASON } from "@lgtmoose/core";
import { redactSensitive } from "@lgtmoose/learnings";
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
  /** Of `repos`, those GitHub said at sign-in the person can write to. */
  writeRepos: string[];
  /** Of `orgs`, those the person owns. */
  ownerOrgs: string[];
  expiresAt: Date;
}

/** One provider's use by review runs in the person's repositories, over a window. */
export interface ProviderUse {
  providerId: string;
  /** Batches (attempts) recorded. */
  batches: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Attempts that hit a rate or plan limit. */
  limitHits: number;
  /** Attempts that moved on to another provider. */
  fallbacks: number;
}

/** A provider sitting out after a limit, for every run of the deployment. */
export interface ProviderCooldown {
  providerId: string;
  until: string;
  reason: string;
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
  /**
   * `open`, or `outdated` (its cited line has changed): only one pull request's list has those
   * (NIC-1140).
   */
  status: "open" | "outdated";
  /** When someone said it's fixed from the CLI or the dashboard (NIC-1140), and who. */
  fixClaimedAt: string | undefined;
  fixClaimedBy: string | undefined;
  createdAt: string;
}

/** A finding someone means to answer (NIC-1140), with what the answer's rules read. */
export interface AnswerTarget {
  id: string;
  /** Lowercased owner/name. */
  repo: string;
  number: number;
  status: string;
  severity: "blocking" | "should_fix" | "nit";
  ruleCategory: string;
  source: "self" | "bot" | "human";
  /** The pull request's author. */
  prAuthor: string;
  /**
   * Whether the recheck can take it, so a fix claim means something: on a line (`path` and
   * `line`) of the new side (RIGHT).
   */
  recheckable: boolean;
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

/**
 * An answer the database refused as invalid (NIC-1140): `lgtmoose_claim_fix` or
 * `lgtmoose_decline_finding` raised (SQLSTATE P0001) on its own checks. The API answers 400.
 */
export class AnswerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerRefusedError";
  }
}

/** The answer functions' own refusals become `AnswerRefusedError`; anything else is rethrown. */
async function answerCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const raised = error as { code?: unknown; message?: unknown; cause?: unknown };
    const cause = raised.cause as { code?: unknown; message?: unknown } | undefined;
    const code = raised.code ?? cause?.code;
    const message = cause?.message ?? raised.message;
    if (code === "P0001" && typeof message === "string") throw new AnswerRefusedError(message);
    throw error;
  }
}

export interface DashboardStore {
  createSession(tokenHash: string, session: DashboardSession): Promise<void>;
  /** The session for a token hash, while it hasn't expired. */
  session(tokenHash: string, now: Date): Promise<DashboardSession | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Removes sessions that have ended. */
  deleteExpired(now: Date): Promise<number>;
  repoSummaries(repos: readonly string[]): Promise<RepoSummary[]>;
  /**
   * Open findings in `repos`, most severe first, at most `limit`. With a pull request `number`
   * (NIC-1140), only that PR's, and its outdated ones too.
   */
  openFindings(repos: readonly string[], limit: number, number?: number): Promise<OpenFinding[]>;
  /** A finding by ID, for an answer (NIC-1140); undefined when there's none. */
  answerTarget(id: string): Promise<AnswerTarget | undefined>;
  /**
   * Records that `login` says an open or outdated finding of ours is fixed (NIC-1140): it's
   * rechecked first on the next run, which alone closes it. False when it isn't open or
   * outdated, or the recheck can't take it (not on a line of the new side).
   */
  claimFix(id: string, login: string): Promise<boolean>;
  /**
   * Declines an open or outdated finding of ours for `login`, with their reason (NIC-1140), as an
   * accepted decline on its thread would: closed, with a `declined` event that outcome learning
   * reads later. False when it isn't open or outdated.
   */
  declineFinding(id: string, login: string, reason: string): Promise<boolean>;
  /** The newest review runs in `repos`, at most `limit`. */
  recentRuns(repos: readonly string[], limit: number): Promise<RunSummary[]>;
  /** Provider use by runs in `repos` since `since`, by provider. */
  providerUse(repos: readonly string[], since: Date): Promise<ProviderUse[]>;
  /** Providers cooling down at `now`. */
  cooldowns(now: Date): Promise<ProviderCooldown[]>;
  /**
   * This month's estimated spend (the spend ledger, NIC-1079): the deployment's, and each of
   * `repos` that spent anything, most first.
   */
  spendThisMonth(
    repos: readonly string[],
    now: Date,
  ): Promise<{ monthUsd: number; repos: { repo: string; usd: number }[] }>;
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
        : {
            login: row.login,
            orgs: row.orgs,
            repos: row.repos,
            writeRepos: row.writeRepos,
            ownerOrgs: row.ownerOrgs,
            expiresAt: row.expiresAt,
          };
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
    async openFindings(repos, limit, number) {
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
          status: findings.status,
          fixClaimedAt: findings.fixClaimedAt,
          fixClaimedBy: findings.fixClaimedBy,
          createdAt: findings.createdAt,
        })
        .from(findings)
        .innerJoin(pullRequests, eq(findings.pullRequestId, pullRequests.id))
        .where(
          and(
            number === undefined
              ? eq(findings.status, "open")
              : inArray(findings.status, ["open", "outdated"]),
            inRepos(repos),
            ...(number === undefined ? [] : [eq(pullRequests.number, number)]),
          ),
        )
        .orderBy(SEVERITY_ORDER, desc(findings.createdAt))
        .limit(limit);
      return rows.map((row) => ({
        ...row,
        status: row.status === "outdated" ? ("outdated" as const) : ("open" as const),
        path: row.path ?? undefined,
        line: row.line ?? undefined,
        sourceLogin: row.sourceLogin ?? undefined,
        fixClaimedAt: iso(row.fixClaimedAt),
        fixClaimedBy: row.fixClaimedBy ?? undefined,
        createdAt: row.createdAt.toISOString(),
      }));
    },
    async answerTarget(id) {
      const [row] = await db
        .select({
          id: findings.id,
          repo: sql<string>`lower(${pullRequests.repo})`,
          number: pullRequests.number,
          status: findings.status,
          severity: findings.severity,
          ruleCategory: findings.ruleCategory,
          source: findings.source,
          prAuthor: pullRequests.author,
          side: findings.side,
          path: findings.path,
          line: findings.line,
        })
        .from(findings)
        .innerJoin(pullRequests, eq(findings.pullRequestId, pullRequests.id))
        .where(eq(findings.id, id))
        .limit(1);
      if (row === undefined) return undefined;
      const { side, path, line, ...target } = row;
      return { ...target, recheckable: side === "RIGHT" && path !== null && line !== null };
    },
    async claimFix(id, login) {
      // Through `lgtmoose_claim_fix` (migration 0025): the dashboard's login may call it, not
      // write findings or events itself. Null when the finding can't take a claim.
      const result = (await answerCall(() =>
        db.execute(sql`select lgtmoose_claim_fix(${id}::uuid, ${login}) as at`),
      )) as unknown as { rows: { at: unknown }[] };
      return result.rows[0]?.at !== null && result.rows[0]?.at !== undefined;
    },
    async declineFinding(id, login, reason) {
      // Through `lgtmoose_decline_finding` (migration 0025), which also writes the `declined`
      // event with the reason and `learn_pending`, for the reconciler's outcome learning. The
      // reason is kept as a reply's body is, with secrets redacted, then capped to what the
      // function takes: redaction can make it longer.
      const stored = redactSensitive(reason).text.slice(0, MAX_DECLINE_REASON).trim();
      const result = (await answerCall(() =>
        db.execute(sql`select lgtmoose_decline_finding(${id}::uuid, ${login}, ${stored}) as done`),
      )) as unknown as { rows: { done: unknown }[] };
      return result.rows[0]?.done === true;
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
    async providerUse(repos, since) {
      if (repos.length === 0) return [];
      const rows = await db
        .select({
          providerId: providerUsage.providerId,
          batches: sql<number>`count(*)`,
          inputTokens: sql<number>`coalesce(sum(${providerUsage.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${providerUsage.outputTokens}), 0)`,
          costUsd: sql<string>`coalesce(sum(${providerUsage.costUsd}), 0)`,
          limitHits: sql<number>`count(*) filter (where ${providerUsage.limitHit})`,
          fallbacks: sql<number>`count(*) filter (where ${providerUsage.fellBackTo} is not null)`,
        })
        .from(providerUsage)
        .innerJoin(reviewRuns, eq(providerUsage.runId, reviewRuns.id))
        .innerJoin(pullRequests, eq(reviewRuns.pullRequestId, pullRequests.id))
        .where(and(inRepos(repos), gt(providerUsage.createdAt, since)))
        .groupBy(providerUsage.providerId)
        .orderBy(providerUsage.providerId);
      return rows.map((row) => ({
        providerId: row.providerId,
        batches: Number(row.batches),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        costUsd: Number(row.costUsd),
        limitHits: Number(row.limitHits),
        fallbacks: Number(row.fallbacks),
      }));
    },
    async spendThisMonth(repos, now) {
      const totals = await postgresSpend(
        db as unknown as Parameters<typeof postgresSpend>[0],
      ).monthTotals(repos, now);
      const byLower = new Map(repos.map((repo) => [repo.toLowerCase(), repo]));
      return {
        monthUsd: totals.monthUsd,
        repos: [...totals.repos]
          .map(([repo, usd]) => ({ repo: byLower.get(repo) ?? repo, usd }))
          .sort((a, b) => b.usd - a.usd || a.repo.localeCompare(b.repo)),
      };
    },
    async cooldowns(now) {
      const rows = await db
        .select()
        .from(providerCooldowns)
        .where(gt(providerCooldowns.until, now))
        .orderBy(providerCooldowns.providerId);
      return rows.map((row) => ({
        providerId: row.providerId,
        until: row.until.toISOString(),
        reason: row.reason,
      }));
    },
  };
}
