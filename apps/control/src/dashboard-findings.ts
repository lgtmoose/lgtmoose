import { DASHBOARD_TOKEN_HEADER } from "@lgtmoose/config";
import { answerRequestSchema, plainLine } from "@lgtmoose/core";
import { DashboardGitHubError, type RepoAccess } from "./dashboard-github.js";
import {
  json,
  sha256Hex,
  type DashboardRequest,
  type DashboardResponse,
} from "./dashboard-http.js";
import type { DashboardDeps } from "./dashboard.js";
import { AnswerRefusedError } from "./dashboard-store.js";
import { resolutionHeld } from "./thread-policy.js";

/**
 * Listing a pull request's findings and answering them (NIC-1140), for the CLI with the person's
 * GitHub token and for the dashboard with its session.
 *
 * - **Token:** the CLI sends a GitHub token in `TOKEN_HEADER` (not `Authorization`, which
 *   CloudFront drops from a GET). GitHub says whose it is and what they can do on the
 *   repository; nothing else about it is kept, and it's never logged. Only these two endpoints
 *   take one, and a request with one never reads the session cookie, so a page can't use a
 *   token to get around the dashboard's origin check.
 * - **Who may see:** as at sign-in, only an active member of the allowed org that owns the
 *   repository (or that account itself), so a public repository's `pull` for everyone lists
 *   nothing. Reading membership needs `read:org` on a classic token, or the organization's
 *   Members permission (read) on a fine-grained one. A classic token without it is told so;
 *   for any other refusal, GitHub's own message is passed on.
 * - **Who may answer:** write access (push, maintain or admin) **and** a token GitHub shows can
 *   write: a classic or OAuth token with the `repo` scope (`public_repo` on a public repository),
 *   such as `gh auth token`. GitHub doesn't report a fine-grained token's permissions, so one
 *   (with Members read) can list, never answer.
 * - **Abuse:** a token that isn't shaped like one, or is an installation token (`ghs_`), is
 *   refused without asking GitHub. By the token's hash, a token GitHub refused is remembered
 *   for ten minutes, and a verified login for an hour after it was last used; membership and
 *   permissions for a minute. These caches are per Lambda instance and nothing caps lookups
 *   across instances: API Gateway's throttle is the limit. What's left is that a flood of
 *   distinct bad tokens, within that throttle, makes as many `/user` calls to GitHub from the
 *   dashboard's address.
 * - **Answers:** `fixed` marks the finding for the next run's recheck, which alone closes it;
 *   only a finding the recheck can take (on a line of the PR's new code) can be marked.
 *   `declined` closes it at once with the reason, as an accepted decline on its thread would,
 *   under the same rule: a blocking or protected finding can't be declined by the pull
 *   request's author. Nothing is posted to GitHub either way.
 */

/** The header the CLI's GitHub token comes in. */
export const TOKEN_HEADER = DASHBOARD_TOKEN_HEADER;

/** A verified token's login is kept this long by its hash after it was last used. */
const LOGIN_TTL_MS = 60 * 60_000;
/** Permission and membership answers are read again after this long. */
const ACCESS_TTL_MS = 60_000;
/** A token GitHub refused is refused again without asking for this long. */
const REFUSED_TTL_MS = 10 * 60_000;
/** Cache entries kept, oldest dropped first: a warm Lambda serves few people. */
const ACCESS_ENTRIES = 500;
/** The most findings one pull request's list returns. */
const PR_FINDINGS_LIMIT = 200;
/** The longest body an answer may have. */
const MAX_BODY = 8192;

const ANSWER_PATH =
  /^\/api\/findings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/ack$/;
const REPO_PARAM = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
/** What a GitHub token looks like: no spaces, nothing a header can't carry, a sane length. */
const TOKEN_SHAPE = /^[A-Za-z0-9_.-]{20,255}$/;
/** What the cache keeps for a token GitHub refused. */
const REFUSED = "\u0000refused";

/**
 * What an asker may do on a repository: `membership-unreadable` when the token can't be shown
 * the person's org membership, which seeing anything needs.
 */
export type AskerAccess = RepoAccess | "membership-unreadable";

/** Who's asking, and what they can do on a repository. */
export interface Asker {
  login: string;
  access(repo: string): Promise<AskerAccess>;
}

/** An asker from what GitHub said about the session's person at sign-in. */
export function sessionAsker(session: {
  login: string;
  repos: readonly string[];
  writeRepos: readonly string[];
}): Asker {
  return {
    login: session.login,
    async access(repo) {
      if (session.writeRepos.includes(repo)) return "write";
      return session.repos.includes(repo) ? "read" : "none";
    },
  };
}

/**
 * A login, an access level or `REFUSED`, by the token's hash (and repository or org). Per
 * Lambda instance (or compose server), and at most `ACCESS_ENTRIES`.
 */
const cache = new Map<string, { value: string; at: number; ttl: number }>();

/** Clears the token cache (tests). */
export function clearTokenCache(): void {
  cache.clear();
}

function remember(key: string, value: string, now: number, ttl: number): void {
  cache.delete(key);
  cache.set(key, { value, at: now, ttl });
  while (cache.size > ACCESS_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** A live entry's value; with `slide`, its time starts again, so one in use doesn't expire. */
function cached(key: string, now: number, slide = false): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined || now - hit.at >= hit.ttl) return undefined;
  if (slide) remember(key, hit.value, now, hit.ttl);
  return hit.value;
}

function ownerAllowed(deps: DashboardDeps, repo: string): boolean {
  const owner = repo.split("/")[0] ?? "";
  return deps.allowedOrgs.some((org) => org.toLowerCase() === owner);
}

/** A GitHub failure as the CLI is told it, or undefined when it isn't one. */
function githubFailure(error: unknown): DashboardResponse | undefined {
  if (!(error instanceof DashboardGitHubError)) return undefined;
  // GitHub's rate limit, whether it answers 403 or 429: for now, not a refusal.
  if (error.rateLimited) {
    return json(503, { error: "GitHub's rate limit was reached: try again in a few minutes" });
  }
  if (error.status === 401) return json(401, { error: "bad-token" });
  // A renamed or transferred repository: GitHub redirects, and the token isn't sent on.
  if (error.status >= 300 && error.status < 400) {
    return json(404, {
      error: "the repository has moved (renamed or transferred): ask for it by its new owner/name",
    });
  }
  if (error.status === 403 && error.sso) {
    return json(403, {
      error:
        "GitHub wants this token authorized for the organization's SAML single sign-on: authorize it on GitHub (Settings, then Tokens, then Configure SSO) and try again",
    });
  }
  if (error.status === 403) {
    // GitHub's own reason (an IP allow list, an OAuth app restriction), as plain text.
    const why = error.githubMessage === undefined ? "" : `: ${plainLine(error.githubMessage)}`;
    return json(403, { error: `GitHub refused this token${why}` });
  }
  // 0 (unreachable), 429 or 5xx: for now.
  return json(503, { error: "GitHub couldn't be asked about your access just now" });
}

/** What a token that can't read org membership is told. */
const MEMBERSHIP_UNREADABLE =
  "this token can't read your organization membership, which seeing findings needs: a classic token needs the read:org scope (`gh auth token` has it), a fine-grained token the organization's Members permission (read)";

/** The asker behind a token, or a response saying why there isn't one. */
async function tokenAsker(deps: DashboardDeps, token: string): Promise<Asker | DashboardResponse> {
  const at = deps.now().getTime();
  // Refused without asking GitHub, and counted nowhere.
  if (!TOKEN_SHAPE.test(token)) return json(401, { error: "bad-token" });
  if (token.startsWith("ghs_")) {
    return json(401, {
      error:
        "this is an installation token, not a person's: use `gh auth token`, or a personal token",
    });
  }
  // Keyed by the token's hash: the token itself is never kept.
  const key = sha256Hex(token);
  // A verified login slides: each use keeps it another hour. A refusal doesn't.
  const known = cached(`login:${key}`, at);
  if (known === REFUSED) return json(401, { error: "bad-token" });
  let login = known === undefined ? undefined : cached(`login:${key}`, at, true);
  if (login === undefined) {
    try {
      login = await deps.github.login(token);
    } catch (error) {
      if (error instanceof DashboardGitHubError && error.status === 401) {
        remember(`login:${key}`, REFUSED, at, REFUSED_TTL_MS);
      }
      const failure = githubFailure(error);
      if (failure !== undefined) return failure;
      throw error;
    }
    remember(`login:${key}`, login, at, LOGIN_TTL_MS);
  }
  const self = login.toLowerCase();
  const lookup = async (cacheKey: string, read: () => Promise<string>): Promise<string> => {
    const now = deps.now().getTime();
    const hit = cached(cacheKey, now);
    if (hit !== undefined) return hit;
    const value = await read();
    remember(cacheKey, value, now, ACCESS_TTL_MS);
    return value;
  };
  return {
    login,
    async access(repo) {
      if (!ownerAllowed(deps, repo)) return "none";
      // What sign-in asks for: an active member of the allowed org that owns the repository (or
      // the account itself). A public repository shows anyone `pull`, so that alone isn't enough.
      const owner = repo.split("/")[0] ?? "";
      if (owner !== self) {
        const member = await lookup(`member:${key}:${owner}`, () =>
          deps.github.membership(token, owner),
        );
        if (member === "unreadable") return "membership-unreadable";
        if (member !== "member") return "none";
      }
      return (await lookup(`access:${key}:${repo}`, () =>
        deps.github.repoAccess(token, repo),
      )) as RepoAccess;
    },
  };
}

function prParams(
  query: DashboardRequest["query"],
): { repo: string; number: number | undefined } | undefined {
  const repo = (query.repo ?? "").trim().toLowerCase();
  if (!REPO_PARAM.test(repo)) return undefined;
  if (query.pr === undefined || query.pr === "") return { repo, number: undefined };
  const number = Number(query.pr);
  // At most Postgres's integer: a bigger one is a bad request, not a failed query.
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PR_NUMBER) return undefined;
  return { repo, number };
}

/** The largest pull request number the database holds (`int4`). */
export const MAX_PR_NUMBER = 2_147_483_647;

/** `GET /api/findings?repo=owner/name&pr=N` with a token: one PR's open and outdated findings. */
async function listForToken(
  deps: DashboardDeps,
  asker: Asker,
  query: DashboardRequest["query"],
): Promise<DashboardResponse> {
  const params = prParams(query);
  if (params?.number === undefined) {
    return json(400, { error: "give repo=owner/name and pr=<number>" });
  }
  const access = await asker.access(params.repo);
  if (access === "membership-unreadable") return json(403, { error: MEMBERSHIP_UNREADABLE });
  // One the person can't see doesn't exist, as far as they can tell.
  if (access === "none") {
    return json(404, {
      error: `no such repository, or you're not a member of ${params.repo.split("/")[0] ?? ""} that this token can show`,
    });
  }
  return json(200, {
    findings: await deps.store.openFindings([params.repo], PR_FINDINGS_LIMIT, params.number),
  });
}

/** `POST /api/findings/:id/ack`: answers one of our findings for `asker`. */
export async function answerFinding(
  deps: DashboardDeps,
  asker: Asker,
  id: string,
  body: string | undefined,
): Promise<DashboardResponse> {
  const target = await deps.store.answerTarget(id);
  const access = target === undefined ? "none" : await asker.access(target.repo);
  if (target === undefined || access === "none") return json(404, { error: "no such finding" });
  if (access === "membership-unreadable") return json(403, { error: MEMBERSHIP_UNREADABLE });
  if (target.source !== "self") {
    return json(409, { error: "only LGTMoose's own findings are answered here" });
  }
  if (access === "token-read-only") {
    return json(403, {
      error: `this token can't write to ${target.repo}: use \`gh auth token\`, or a classic token with the repo and read:org scopes (GitHub doesn't report a fine-grained token's permissions)`,
    });
  }
  if (access !== "write") return json(403, { error: `needs write access on ${target.repo}` });
  if (body === undefined || body.length > MAX_BODY) return json(400, { error: "bad body" });
  let parsed;
  try {
    parsed = answerRequestSchema.safeParse(JSON.parse(body));
  } catch {
    return json(400, { error: "bad body" });
  }
  if (!parsed.success) {
    return json(400, { error: parsed.error.issues[0]?.message ?? "bad body" });
  }
  const answer = parsed.data;
  if (target.status !== "open" && target.status !== "outdated") {
    return json(409, { error: `already ${target.status.replaceAll("_", " ")}` });
  }
  if (answer.outcome === "fixed" && !target.recheckable) {
    return json(409, {
      error:
        "a recheck can't check this finding (it isn't on a line of the pull request's new code): decline it with a reason, or leave it for a review to raise again",
    });
  }
  if (answer.outcome === "declined") {
    // The rule a resolved thread or `ignore` follows: one that holds a merge isn't self-service.
    const held = await resolutionHeld(target, asker.login, target.prAuthor, async () => "write");
    if (held !== undefined) {
      return json(403, {
        error:
          "a blocking or protected finding can't be declined by the pull request's author; someone else with write access can",
      });
    }
  }
  let done: boolean;
  try {
    done =
      answer.outcome === "fixed"
        ? await deps.store.claimFix(target.id, asker.login)
        : await deps.store.declineFinding(target.id, asker.login, answer.reason);
  } catch (error) {
    // The database's own checks refused it: the request was invalid, not the server.
    if (error instanceof AnswerRefusedError) return json(400, { error: error.message });
    throw error;
  }
  if (!done) return json(409, { error: "already closed" });
  // Who answered what; never the reason's text or a token.
  deps.log("finding answered", {
    findingId: target.id,
    repo: target.repo,
    number: target.number,
    outcome: answer.outcome,
    login: asker.login,
  });
  return json(200, { id: target.id, outcome: answer.outcome });
}

/**
 * A request carrying `TOKEN_HEADER`: the findings list or an answer, for the CLI. Undefined when
 * there's no token, so the session handles the request as before.
 */
export async function handleTokenRequest(
  deps: DashboardDeps,
  request: DashboardRequest,
): Promise<DashboardResponse | undefined> {
  const token = request.headers[TOKEN_HEADER];
  if (token === undefined) return undefined;
  const answer = request.method === "POST" ? ANSWER_PATH.exec(request.path) : null;
  const listing = request.method === "GET" && request.path === "/api/findings";
  if (answer === null && !listing) return json(404, { error: "not found" });
  try {
    const asker = await tokenAsker(deps, token.trim());
    if ("status" in asker) return asker;
    if (answer?.[1] !== undefined) return await answerFinding(deps, asker, answer[1], request.body);
    return await listForToken(deps, asker, request.query);
  } catch (error) {
    const failure = githubFailure(error);
    if (failure === undefined) throw error;
    deps.log("findings request: GitHub refused or unreachable", {
      status: error instanceof DashboardGitHubError ? error.status : undefined,
    });
    return failure;
  }
}

export { ANSWER_PATH, PR_FINDINGS_LIMIT, prParams };
