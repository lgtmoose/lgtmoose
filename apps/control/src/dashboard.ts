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
 */

export interface DashboardDeps {
  store: DashboardStore;
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
    for (const org of deps.allowedOrgs) {
      const name = org.toLowerCase();
      // A user account in allowedOrgs has one member: its own login.
      if (name === user.toLowerCase() || (await deps.github.isOrgMember(token, org))) {
        orgs.push(name);
      }
    }
    if (orgs.length === 0) {
      deps.log("dashboard sign-in refused: not a member of an allowed org", { login: user });
      return signedOut("not-member", clear);
    }
    const repos = await deps.github.visibleRepos(token, new Set(orgs), REPO_LIMIT);
    const now = deps.now();
    const hours = SESSION_HOURS * 3600;
    const seconds = Math.min(hours, exchanged.expiresInSeconds ?? hours);
    const session = randomToken();
    await deps.store.createSession(sha256Hex(session), {
      login: user,
      orgs,
      repos,
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
  switch (route) {
    case "GET /api/me":
      return json(200, {
        login: session.login,
        orgs: session.orgs,
        repos: session.repos.length,
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
    default:
      return json(404, { error: "not found" });
  }
}
