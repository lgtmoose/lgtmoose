import { feedbackReportSchema } from "@lgtmoose/core";
import {
  approveLearning,
  forgetLearning,
  summarizeLearning,
  type Learning,
  type LearningDeps,
  type LearningStatus,
  type LearningStore,
} from "@lgtmoose/learnings";
import { z } from "zod";
import { authorizeUrl, type DashboardGitHub } from "./dashboard-github.js";
import {
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  clearCookie,
  empty,
  json,
  pkceChallenge,
  randomToken,
  redirect,
  safeEqual,
  setCookie,
  sha256Hex,
  sign,
  verify,
  type DashboardRequest,
  type DashboardResponse,
} from "./dashboard-http.js";
import type { DashboardSession, DashboardStore } from "./dashboard-store.js";
import { BOOTSTRAP_DEFAULTS } from "./bootstrap.js";
import type { Bootstrap, BootstrapStore } from "./bootstrap-store.js";

/**
 * The dashboard API (NIC-840), behind the dashboard's CloudFront distribution at `/api/*`, so the
 * browser only ever talks to one origin: no CORS, and cookies that are first-party.
 *
 * - **Sign-in:** the App's OAuth with `state` and PKCE, the code exchanged here with the client
 *   secret. Only members of an allowed org get a session. The person's GitHub token is used to
 *   read who they are and what they can see, then dropped.
 * - **Session:** a random token in a `__Host-`, HttpOnly, Secure, SameSite=Lax cookie; the
 *   database keeps only its SHA-256. It ends after `SESSION_HOURS` (or when GitHub's token would
 *   have), and signing in again re-checks membership.
 * - **Scope:** every read is limited to the repositories the person could see through the App at
 *   sign-in, within the allowed orgs.
 * - **Writes:** a request that changes anything must come from the dashboard's own origin
 *   (`Origin`, and `Sec-Fetch-Site` when the browser sends it), on top of SameSite.
 * - **Learnings:** approving and rejecting go through `approveLearning` and `forgetLearning`, with
 *   the session's login as the actor. Their permission checks read what GitHub said about the
 *   person at sign-in (write access per repository, owner per org), never the App's key, so a
 *   grant GitHub has since taken away lasts until the session ends, at most `SESSION_HOURS`.
 */

export interface DashboardDeps {
  store: DashboardStore;
  learnings: LearningStore;
  /** The feedback report (`FEEDBACK_REPORT_KEY`) as stored, or undefined when there's none yet. */
  feedbackReport(): Promise<unknown>;
  github: DashboardGitHub;
  /** The App's OAuth client; undefined until setup or deploy has stored it. */
  oauthClient(): Promise<{ clientId: string; clientSecret: string } | undefined>;
  /** The key that signs the sign-in cookie. */
  signingKey(): Promise<Buffer>;
  /** The dashboard's origin, `https://<host>`, where the browser is. */
  origin(): Promise<string>;
  /** The deploy config's `allowedOrgs`. */
  allowedOrgs: readonly string[];
  /** GitHub's web URL, for sign-in; github.com by default. */
  webUrl?: string;
  /**
   * Learning from review history (NIC-1080): the bootstraps, and what a request asks for by
   * default. Left out, the dashboard shows none and can't start one.
   */
  bootstraps?: {
    store: BootstrapStore;
    /** Merged PRs a request reads unless it says otherwise. */
    maxPrs: number;
  };
  now(): Date;
  log(message: string, fields?: Record<string, unknown>): void;
}

/** How long a session lasts before signing in again. */
export const SESSION_HOURS = 8;
/** How long the trip to GitHub and back may take. */
const SIGN_IN_SECONDS = 10 * 60;
/** Repositories kept per session; an org with more shows the first ones by name. */
export const REPO_LIMIT = 2000;
const FINDINGS_LIMIT = 500;
const RUNS_LIMIT = 100;
/** How far back provider usage is summed. */
export const USAGE_DAYS = 30;

/** Why sign-in didn't finish, as the page is told in `#/signed-out?error=…`: codes only. */
export type SignInError = "denied" | "expired" | "github" | "not-configured" | "not-member";

export const CALLBACK_PATH = "/api/auth/callback";

const signInSchema = z.object({
  state: z.string().min(16),
  verifier: z.string().min(43),
  expiresAt: z.number(),
});

const REPO_PARAM = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

function signedOut(error: SignInError, cookies: string[] = []): DashboardResponse {
  return redirect(`/#/signed-out?error=${error}`, cookies);
}

/** Whether a request that changes state came from the dashboard's own pages. */
function fromDashboard(request: DashboardRequest, origin: string): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false;
  return request.headers.origin === origin;
}

async function currentSession(
  deps: DashboardDeps,
  request: DashboardRequest,
): Promise<{ hash: string; session: DashboardSession } | undefined> {
  const token = request.cookies[SESSION_COOKIE];
  if (token === undefined || token === "") return undefined;
  const hash = sha256Hex(token);
  const session = await deps.store.session(hash, deps.now());
  return session === undefined ? undefined : { hash, session };
}

async function login(deps: DashboardDeps): Promise<DashboardResponse> {
  const client = await deps.oauthClient();
  if (client === undefined) return signedOut("not-configured");
  const origin = await deps.origin();
  const state = randomToken();
  const verifier = randomToken(48);
  const cookie = sign(await deps.signingKey(), {
    state,
    verifier,
    expiresAt: deps.now().getTime() + SIGN_IN_SECONDS * 1000,
  });
  return redirect(
    authorizeUrl({
      ...(deps.webUrl === undefined ? {} : { webUrl: deps.webUrl }),
      clientId: client.clientId,
      redirectUri: `${origin}${CALLBACK_PATH}`,
      state,
      codeChallenge: pkceChallenge(verifier),
    }),
    [setCookie(SIGN_IN_COOKIE, cookie, SIGN_IN_SECONDS)],
  );
}

async function callback(
  deps: DashboardDeps,
  request: DashboardRequest,
): Promise<DashboardResponse> {
  // The sign-in cookie is single use: cleared whatever happens next.
  const clear = [clearCookie(SIGN_IN_COOKIE)];
  if (request.query.error !== undefined) return signedOut("denied", clear);
  const signIn = signInSchema.safeParse(
    verify(await deps.signingKey(), request.cookies[SIGN_IN_COOKIE]),
  );
  const state = request.query.state;
  const code = request.query.code;
  if (
    !signIn.success ||
    signIn.data.expiresAt <= deps.now().getTime() ||
    state === undefined ||
    code === undefined ||
    !safeEqual(state, signIn.data.state)
  ) {
    return signedOut("expired", clear);
  }
  const client = await deps.oauthClient();
  if (client === undefined) return signedOut("not-configured", clear);
  try {
    const origin = await deps.origin();
    const exchanged = await deps.github.exchangeCode({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code,
      redirectUri: `${origin}${CALLBACK_PATH}`,
      verifier: signIn.data.verifier,
    });
    if (exchanged === undefined) return signedOut("expired", clear);
    const { token } = exchanged;
    const user = await deps.github.login(token);
    const orgs: string[] = [];
    const ownerOrgs: string[] = [];
    for (const org of deps.allowedOrgs) {
      const name = org.toLowerCase();
      // A user account in allowedOrgs has one member, who owns it: its own login.
      const role = name === user.toLowerCase() ? "admin" : await deps.github.orgRole(token, org);
      if (role === "none") continue;
      orgs.push(name);
      if (role === "admin") ownerOrgs.push(name);
    }
    if (orgs.length === 0) {
      deps.log("dashboard sign-in refused: not a member of an allowed org", { login: user });
      return signedOut("not-member", clear);
    }
    const { repos, writeRepos } = await deps.github.visibleRepos(token, new Set(orgs), REPO_LIMIT);
    const now = deps.now();
    const hours = SESSION_HOURS * 3600;
    const seconds = Math.min(hours, exchanged.expiresInSeconds ?? hours);
    const session = randomToken();
    await deps.store.createSession(sha256Hex(session), {
      login: user,
      orgs,
      repos,
      writeRepos,
      ownerOrgs,
      expiresAt: new Date(now.getTime() + seconds * 1000),
    });
    await deps.store.deleteExpired(now);
    deps.log("dashboard sign-in", { login: user, orgs, repos: repos.length });
    return redirect("/", [...clear, setCookie(SESSION_COOKIE, session, seconds)]);
  } catch (error) {
    deps.log("dashboard sign-in failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return signedOut("github", clear);
  }
}

/** The repositories a read covers: one the person can see, or all of them. */
function scope(session: DashboardSession, repo: string | undefined): string[] | undefined {
  if (repo === undefined || repo === "") return session.repos;
  const name = repo.toLowerCase();
  if (!REPO_PARAM.test(name) || !session.repos.includes(name)) return undefined;
  return [name];
}

const LEARNING_STATUSES: readonly LearningStatus[] = ["pending", "active", "retired"];
/** The most learnings one list shows, newest first. */
const LEARNINGS_LIMIT = 200;
const LEARNING_ACTION = /^\/api\/learnings\/([0-9a-f-]{36})\/(approve|reject)$/;

/** Whether the person may see a learning: one of their repositories', or an org-wide one of theirs. */
function canSee(session: DashboardSession, learning: Learning): boolean {
  return learning.repo === undefined
    ? session.orgs.includes(learning.org.toLowerCase())
    : session.repos.includes(learning.repo.toLowerCase());
}

/** A learning as the dashboard shows it: its text is untrusted, and the page shows it as text. */
function learningView(learning: Learning) {
  return {
    id: learning.id,
    status: learning.status,
    kind: learning.kind,
    category: learning.category,
    scope: summarizeLearning(learning).scope,
    org: learning.org,
    repo: learning.repo,
    text: learning.text,
    author: learning.author,
    sourceRepo: learning.sourceRepo,
    sourcePr: learning.sourcePr,
    hits: learning.hits,
    createdAt: learning.createdAt.toISOString(),
    lastUsedAt: learning.lastUsedAt?.toISOString(),
    retiredAt: learning.retiredAt?.toISOString(),
  };
}

/**
 * The learnings policy's permission readers, answered from the session: what GitHub said about
 * the signed-in person at sign-in. Anyone else has no access.
 */
function sessionAccess(session: DashboardSession): Omit<LearningDeps, "store"> {
  const isSelf = (login: string) => login.toLowerCase() === session.login.toLowerCase();
  return {
    async permissions(repo, login) {
      const name = repo.toLowerCase();
      if (!isSelf(login) || !session.repos.includes(name)) return "none";
      return session.writeRepos.includes(name) ? "write" : "read";
    },
    async orgRoles(org, login) {
      const name = org.toLowerCase();
      if (!isSelf(login) || !session.orgs.includes(name)) return "none";
      return session.ownerOrgs.includes(name) ? "admin" : "member";
    },
  };
}

async function listLearnings(
  deps: DashboardDeps,
  session: DashboardSession,
  status: string | undefined,
): Promise<DashboardResponse> {
  const wanted = status ?? "pending";
  if (!(LEARNING_STATUSES as readonly string[]).includes(wanted)) {
    return json(400, { error: "unknown status" });
  }
  const lists = await Promise.all(
    session.orgs.map((org) => deps.learnings.list({ org, status: wanted as LearningStatus })),
  );
  const learnings = lists
    .flat()
    .filter((learning) => canSee(session, learning))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, LEARNINGS_LIMIT)
    .map(learningView);
  return json(200, { learnings });
}

async function changeLearning(
  deps: DashboardDeps,
  session: DashboardSession,
  id: string,
  action: "approve" | "reject",
): Promise<DashboardResponse> {
  const learning = await deps.learnings.get(id);
  // One the person can't see doesn't exist, as far as they can tell.
  if (learning === undefined || !canSee(session, learning)) {
    return json(404, { error: "no such learning" });
  }
  const policy: LearningDeps = { store: deps.learnings, ...sessionAccess(session) };
  const actor = { login: session.login };
  const result =
    action === "approve"
      ? await approveLearning(policy, id, actor)
      : await forgetLearning(policy, id, actor);
  if (result.outcome === "refused") return json(403, { error: result.reason });
  deps.log("dashboard learning changed", {
    id,
    action,
    outcome: result.outcome,
    login: session.login,
  });
  return json(200, {
    outcome: result.outcome,
    learning: result.learning === undefined ? undefined : learningView(result.learning),
  });
}

const BOOTSTRAP_ACTION = /^\/api\/bootstraps\/([0-9a-f-]{36})\/(approve|reject)$/;
/** Bootstraps listed, newest first, and their items read for pending learnings. */
const BOOTSTRAPS_LIMIT = 20;
const BOOTSTRAP_ITEMS_LIMIT = 500;

/** A bootstrap as the dashboard shows it. */
function bootstrapView(bootstrap: Bootstrap) {
  return {
    id: bootstrap.id,
    repo: bootstrap.repo,
    status: bootstrap.status,
    requestedBy: bootstrap.requestedBy,
    prsRead: bootstrap.prsRead,
    commentsRead: bootstrap.commentsRead,
    proposed: bootstrap.proposed,
    costUsd: bootstrap.costUsd,
    capped: bootstrap.capped,
    error: bootstrap.error,
    createdAt: bootstrap.createdAt.toISOString(),
    finishedAt: bootstrap.finishedAt?.toISOString(),
  };
}

/**
 * Learning from review history (NIC-1080): the person's repositories' bootstraps, and the
 * learnings they proposed that are still pending, each with the comments it rests on, for the
 * Bootstrap queue. `writeRepos` says where they may start one.
 */
async function listBootstraps(
  deps: DashboardDeps,
  session: DashboardSession,
): Promise<DashboardResponse> {
  const bootstraps = deps.bootstraps;
  if (bootstraps === undefined) return json(200, { enabled: false, bootstraps: [], items: [] });
  const recent = await bootstraps.store.recent(session.repos, BOOTSTRAPS_LIMIT);
  const items = (await bootstraps.store.items({ repos: session.repos })).slice(-BOOTSTRAP_ITEMS_LIMIT);
  const pending = [];
  for (const item of items) {
    const learning = await deps.learnings.get(item.learningId);
    if (learning === undefined || learning.status !== "pending" || !canSee(session, learning)) {
      continue;
    }
    pending.push({ bootstrapId: item.bootstrapId, learning: learningView(learning), sources: item.sources });
    if (pending.length >= LEARNINGS_LIMIT) break;
  }
  return json(200, {
    enabled: true,
    bootstraps: recent.map(bootstrapView),
    items: pending,
    writeRepos: session.writeRepos,
    defaults: { maxPrs: bootstraps.maxPrs },
  });
}

/**
 * Asks for a bootstrap of `repo`: only someone GitHub said at sign-in has write access there,
 * since it spends model time. The reconciler starts it on its next run.
 */
async function requestBootstrap(
  deps: DashboardDeps,
  session: DashboardSession,
  query: DashboardRequest["query"],
): Promise<DashboardResponse> {
  const bootstraps = deps.bootstraps;
  if (bootstraps === undefined) return json(404, { error: "not found" });
  const repo = (query.repo ?? "").trim().toLowerCase();
  if (!session.repos.includes(repo)) return json(404, { error: "no such repository" });
  if (!session.writeRepos.includes(repo)) {
    return json(403, { error: `needs write access on ${repo}` });
  }
  const prs = query.prs === undefined ? bootstraps.maxPrs : Number(query.prs);
  if (!Number.isSafeInteger(prs) || prs < 1 || prs > BOOTSTRAP_DEFAULTS.maxPrsLimit) {
    return json(400, { error: `prs is a whole number from 1 to ${BOOTSTRAP_DEFAULTS.maxPrsLimit}` });
  }
  const result = await bootstraps.store.request({
    repo,
    requestedBy: session.login,
    maxPrs: prs,
    // The deployment's cap (`learnings.bootstrapMaxCostUsd`) applies: the prepare step takes the
    // lower of the two.
    maxCostUsd: BOOTSTRAP_DEFAULTS.maxCostUsdLimit,
    resume: query.resume === "1",
  });
  deps.log("dashboard bootstrap requested", { repo, login: session.login, created: result.created });
  return result.created
    ? json(202, { bootstrap: bootstrapView(result.bootstrap) })
    : json(409, { error: "already-requested", bootstrap: bootstrapView(result.active) });
}

/**
 * Approves or rejects every pending learning a bootstrap proposed, each through the learnings
 * policy with the session's access, as one at a time would.
 */
async function changeBootstrap(
  deps: DashboardDeps,
  session: DashboardSession,
  id: string,
  action: "approve" | "reject",
): Promise<DashboardResponse> {
  const bootstraps = deps.bootstraps;
  const bootstrap = await bootstraps?.store.get(id);
  if (bootstraps === undefined || bootstrap === undefined || !session.repos.includes(bootstrap.repo)) {
    return json(404, { error: "no such bootstrap" });
  }
  const policy: LearningDeps = { store: deps.learnings, ...sessionAccess(session) };
  const actor = { login: session.login };
  let done = 0;
  let refused = 0;
  for (const item of await bootstraps.store.items({ bootstrapId: id })) {
    const learning = await deps.learnings.get(item.learningId);
    if (learning === undefined || learning.status !== "pending" || !canSee(session, learning)) {
      continue;
    }
    const result =
      action === "approve"
        ? await approveLearning(policy, learning.id, actor)
        : await forgetLearning(policy, learning.id, actor);
    if (result.outcome === "done") done += 1;
    if (result.outcome === "refused") refused += 1;
  }
  deps.log("dashboard bootstrap changed", { id, action, done, refused, login: session.login });
  return json(200, { done, refused });
}

/** The feedback report's categories, and its declined findings in the person's repositories. */
async function acceptance(
  deps: DashboardDeps,
  session: DashboardSession,
): Promise<DashboardResponse> {
  const stored = await deps.feedbackReport();
  if (stored === undefined) return json(200, { report: null });
  const report = feedbackReportSchema.safeParse(stored);
  if (!report.success) {
    deps.log("dashboard feedback report unreadable");
    return json(200, { report: null });
  }
  return json(200, {
    report: {
      ...report.data,
      declined: report.data.declined.filter((entry) =>
        session.repos.includes(entry.repo.toLowerCase()),
      ),
    },
  });
}

/** Handles one request to `/api/*`. */
export async function handleDashboardRequest(
  deps: DashboardDeps,
  request: DashboardRequest,
): Promise<DashboardResponse> {
  const route = `${request.method} ${request.path}`;
  if (route === "GET /api/auth/login") return login(deps);
  if (route === `GET ${CALLBACK_PATH}`) return callback(deps, request);
  if (request.method !== "GET" && !fromDashboard(request, await deps.origin())) {
    return json(403, { error: "cross-origin" });
  }
  const current = await currentSession(deps, request);
  if (route === "POST /api/auth/logout") {
    if (current !== undefined) await deps.store.deleteSession(current.hash);
    return empty(204, [clearCookie(SESSION_COOKIE)]);
  }
  if (current === undefined) {
    const cookies =
      request.cookies[SESSION_COOKIE] === undefined ? [] : [clearCookie(SESSION_COOKIE)];
    return json(401, { error: "signed-out" }, cookies);
  }
  const { session } = current;
  const action = request.method === "POST" ? LEARNING_ACTION.exec(request.path) : null;
  if (action?.[1] !== undefined && (action[2] === "approve" || action[2] === "reject")) {
    return changeLearning(deps, session, action[1], action[2]);
  }
  const bulk = request.method === "POST" ? BOOTSTRAP_ACTION.exec(request.path) : null;
  if (bulk?.[1] !== undefined && (bulk[2] === "approve" || bulk[2] === "reject")) {
    return changeBootstrap(deps, session, bulk[1], bulk[2]);
  }
  switch (route) {
    case "GET /api/bootstraps":
      return listBootstraps(deps, session);
    case "POST /api/bootstraps":
      return requestBootstrap(deps, session, request.query);
    case "GET /api/me":
      return json(200, {
        login: session.login,
        orgs: session.orgs,
        repos: session.repos.length,
        writeRepos: session.writeRepos.length,
        ownerOrgs: session.ownerOrgs,
        expiresAt: session.expiresAt.toISOString(),
      });
    case "GET /api/repos":
      return json(200, { repos: await deps.store.repoSummaries(session.repos) });
    case "GET /api/findings": {
      const repos = scope(session, request.query.repo);
      if (repos === undefined) return json(404, { error: "no such repository" });
      return json(200, { findings: await deps.store.openFindings(repos, FINDINGS_LIMIT) });
    }
    case "GET /api/runs": {
      const repos = scope(session, request.query.repo);
      if (repos === undefined) return json(404, { error: "no such repository" });
      return json(200, { runs: await deps.store.recentRuns(repos, RUNS_LIMIT) });
    }
    case "GET /api/learnings":
      return listLearnings(deps, session, request.query.status);
    case "GET /api/usage": {
      const now = deps.now();
      const since = new Date(now.getTime() - USAGE_DAYS * 24 * 3600 * 1000);
      return json(200, {
        days: USAGE_DAYS,
        providers: await deps.store.providerUse(session.repos, since),
        cooldowns: await deps.store.cooldowns(now),
      });
    }
    case "GET /api/acceptance":
      return acceptance(deps, session);
    default:
      return json(404, { error: "not found" });
  }
}
