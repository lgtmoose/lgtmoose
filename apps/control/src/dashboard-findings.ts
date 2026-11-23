import { answerRequestSchema } from "@lgtmoose/core";
import { DashboardGitHubError } from "./dashboard-github.js";
import {
  json,
  sha256Hex,
  type DashboardRequest,
  type DashboardResponse,
} from "./dashboard-http.js";
import type { DashboardDeps } from "./dashboard.js";
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
 * - **Who may:** reading the repository through GitHub lists its findings; write access (push,
 *   maintain or admin) answers them. The repository's owner must be one of `allowedOrgs`.
 * - **Answers:** `fixed` marks the finding for the next run's recheck, which alone closes it.
 *   `declined` closes it with the reason, as an accepted decline on its thread would, under the
 *   same rule: a blocking or protected finding can't be declined by the pull request's author.
 *   Nothing is posted to GitHub either way.
 */

/** The header the CLI's GitHub token comes in. */
export const TOKEN_HEADER = "x-lgtmoose-github-token";

/** A token's login, and its access per repository, are read again after this long. */
const ACCESS_TTL_MS = 60_000;
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

/** Who's asking, and what they can do on a repository. */
export interface Asker {
  login: string;
  access(repo: string): Promise<"write" | "read" | "none">;
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

/** A login, or an access level, by the token's hash (and repository). */
const cache = new Map<string, { value: string; at: number }>();

/** Clears the token cache (tests). */
export function clearTokenCache(): void {
  cache.clear();
}

async function cachedRead<T extends string>(
  key: string,
  now: number,
  read: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < ACCESS_TTL_MS) return hit.value as T;
  const value = await read();
  cache.delete(key);
  cache.set(key, { value, at: now });
  while (cache.size > ACCESS_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

function ownerAllowed(deps: DashboardDeps, repo: string): boolean {
  const owner = repo.split("/")[0] ?? "";
  return deps.allowedOrgs.some((org) => org.toLowerCase() === owner);
}

/** The asker behind a token, or a response saying why there isn't one. */
async function tokenAsker(deps: DashboardDeps, token: string): Promise<Asker | DashboardResponse> {
  if (!TOKEN_SHAPE.test(token)) return json(401, { error: "bad-token" });
  // Keyed by the token's hash: the token itself is never kept.
  const key = sha256Hex(token);
  const now = () => deps.now().getTime();
  let login: string;
  try {
    login = await cachedRead(`login:${key}`, now(), () => deps.github.login(token));
  } catch (error) {
    if (error instanceof DashboardGitHubError) return json(401, { error: "bad-token" });
    throw error;
  }
  return {
    login,
    access: (repo) =>
      ownerAllowed(deps, repo)
        ? cachedRead(`access:${key}:${repo}`, now(), () => deps.github.repoAccess(token, repo))
        : Promise.resolve("none"),
  };
}

function prParams(
  query: DashboardRequest["query"],
): { repo: string; number: number | undefined } | undefined {
  const repo = (query.repo ?? "").trim().toLowerCase();
  if (!REPO_PARAM.test(repo)) return undefined;
  if (query.pr === undefined || query.pr === "") return { repo, number: undefined };
  const number = Number(query.pr);
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  return { repo, number };
}

/** `GET /api/findings?repo=owner/name&pr=N` with a token: one PR's open findings. */
async function listForToken(
  deps: DashboardDeps,
  asker: Asker,
  query: DashboardRequest["query"],
): Promise<DashboardResponse> {
  const params = prParams(query);
  if (params?.number === undefined) {
    return json(400, { error: "give repo=owner/name and pr=<number>" });
  }
  // One the person can't read doesn't exist, as far as they can tell.
  if ((await asker.access(params.repo)) === "none") {
    return json(404, { error: "no such repository" });
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
  if (target.source !== "self") {
    return json(409, { error: "only LGTMoose's own findings are answered here" });
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
  const done =
    answer.outcome === "fixed"
      ? await deps.store.claimFix(target.id, asker.login, deps.now())
      : await deps.store.declineFinding(target.id, asker.login, answer.reason);
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
  const asker = await tokenAsker(deps, token.trim());
  if ("status" in asker) return asker;
  if (answer?.[1] !== undefined) return answerFinding(deps, asker, answer[1], request.body);
  return listForToken(deps, asker, request.query);
}

export { ANSWER_PATH, prParams };
