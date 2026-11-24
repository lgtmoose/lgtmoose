import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { findingEvents, findings, pullRequests } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { drizzleLearningStore } from "@lgtmoose/learnings";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleFindingStore, drizzleRunStore } from "./aws.js";
import { CALLBACK_PATH, handleDashboardRequest, type DashboardDeps } from "./dashboard.js";
import { TOKEN_HEADER, clearTokenCache } from "./dashboard-findings.js";
import { DashboardGitHubError, type DashboardGitHub, type RepoAccess } from "./dashboard-github.js";
import { SESSION_COOKIE, SIGN_IN_COOKIE, type DashboardRequest } from "./dashboard-http.js";
import { AnswerRefusedError, drizzleDashboardStore } from "./dashboard-store.js";
import { learnFromAnswers } from "./finding-answers.js";
import { drizzleAnswerLearningStore } from "./outcome-learning-aws.js";

/**
 * Listing a PR's findings and answering them (NIC-1140), against the real Postgres stores: with
 * the CLI's GitHub token, and with the dashboard's session.
 */

const ORIGIN = "https://d123.cloudfront.net";
const NOW = new Date("2026-11-23T10:00:00Z");
const client = new PGlite({ extensions: { vector } });
const db = drizzle(client);
const learnings = drizzleLearningStore(db);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  await client.close();
});

const WRITER = "ghp_writer_token_aaaaaaaaaaaa";
const READER = "ghp_reader_token_bbbbbbbbbbbb";
const AUTHOR = "ghp_author_token_cccccccccccc";
const STRANGER = "ghp_stranger_token_dddddddddd";
/** The person may write, but the token can't: a fine-grained or scopeless token. */
const LIMITED = "github_pat_limited_ffffffffff";
const SSO = "ghp_sso_token_gggggggggggggggg";
const FORBIDDEN = "ghp_forbidden_token_hhhhhhhhhh";
const DOWN = "ghp_down_token_iiiiiiiiiiiiiiii";
const LIMITED_RATE = "ghp_rate_token_jjjjjjjjjjjjjjj";
/** Someone outside the org: GitHub shows them `pull` on a public repository. */
const OUTSIDER = "ghp_outsider_token_kkkkkkkkkkk";
/** A classic token without read:org: its membership can't be read. */
const NO_READ_ORG = "ghp_no_read_org_mmmmmmmmmmmm";
/** The repository was renamed: GitHub redirects. */
const MOVED = "ghp_moved_token_nnnnnnnnnnnnnn";

const people: Record<string, { login: string; access: RepoAccess }> = {
  [WRITER]: { login: "Carol", access: "write" },
  [READER]: { login: "Dan", access: "read" },
  [AUTHOR]: { login: "bob", access: "write" },
  [STRANGER]: { login: "Eve", access: "none" },
  [LIMITED]: { login: "Fay", access: "token-read-only" },
  [SSO]: { login: "Gus", access: "write" },
  [FORBIDDEN]: { login: "Hal", access: "write" },
  [DOWN]: { login: "Ivy", access: "write" },
  [LIMITED_RATE]: { login: "Jo", access: "write" },
  [OUTSIDER]: { login: "Kim", access: "read" },
  [NO_READ_ORG]: { login: "Lee", access: "write" },
  [MOVED]: { login: "Max", access: "write" },
  // The dashboard session's own sign-in token.
  gho_user: { login: "Alice", access: "write" },
};

const lookups: string[] = [];

const github: DashboardGitHub = {
  exchangeCode: async () => ({ token: "gho_user", expiresInSeconds: 28_800 }),
  async login(token) {
    lookups.push(`login:${token}`);
    const person = people[token];
    if (person === undefined) throw new DashboardGitHubError("reading the signed-in user", 401);
    return person.login;
  },
  orgRole: async (_token, org) => (org === "acme" ? "member" : "none"),
  async membership(token, org) {
    lookups.push(`member:${token}:${org}`);
    if (token === NO_READ_ORG) return "unreadable";
    return org === "acme" && token !== OUTSIDER ? "member" : "none";
  },
  visibleRepos: async () => ({ repos: ["acme/api", "acme/web"], writeRepos: ["acme/api"] }),
  async repoAccess(token, repo) {
    lookups.push(`access:${token}:${repo}`);
    if (token === SSO) throw new DashboardGitHubError("reading a repository", 403, true);
    if (token === FORBIDDEN) {
      throw new DashboardGitHubError("reading a repository", 403, false, false, {
        githubMessage:
          "Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled",
      });
    }
    if (token === DOWN) throw new DashboardGitHubError("reading a repository", 0);
    if (token === MOVED) throw new DashboardGitHubError("reading a repository", 301);
    if (token === LIMITED_RATE) {
      throw new DashboardGitHubError("reading a repository", 403, false, true);
    }
    return repo === "acme/api" ? (people[token]?.access ?? "none") : "none";
  },
};

const logged: { message: string; fields?: Record<string, unknown> }[] = [];

const deps: DashboardDeps = {
  store: drizzleDashboardStore(db),
  learnings,
  feedbackReport: async () => undefined,
  github,
  oauthClient: async () => ({ clientId: "c", clientSecret: "s" }),
  signingKey: async () => Buffer.from("k".repeat(64)),
  origin: async () => ORIGIN,
  allowedOrgs: ["acme"],
  now: () => now,
  log: (message, fields) => logged.push({ message, ...(fields === undefined ? {} : { fields }) }),
};

function request(
  method: string,
  path: string,
  options: Partial<Omit<DashboardRequest, "method" | "path">> = {},
): DashboardRequest {
  return { method, path, query: {}, headers: {}, cookies: {}, ...options };
}

const withToken = (token: string, options: Partial<DashboardRequest> = {}) => ({
  ...options,
  headers: { [TOKEN_HEADER]: token, ...options.headers },
});

const ack = (id: string, token: string, body: unknown) =>
  handleDashboardRequest(
    deps,
    request("POST", `/api/findings/${id}/ack`, withToken(token, { body: JSON.stringify(body) })),
  );

let pullId = "";

async function finding(values: Partial<typeof findings.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(findings)
    .values({
      pullRequestId: pullId,
      fingerprint: `fp:${Math.random()}`,
      ruleCategory: "correctness",
      severity: "should_fix",
      title: "Quantity drops the note",
      body: "The merge loses the note.",
      path: "src/cart.ts",
      line: 4,
      side: "RIGHT",
      raisedAtSha: "a".repeat(40),
      ...values,
    })
    .returning({ id: findings.id });
  return row?.id ?? "";
}

let now = NOW;

beforeEach(async () => {
  now = NOW;
  clearTokenCache();
  lookups.length = 0;
  logged.length = 0;
  await db.delete(pullRequests);
  const [pull] = await db
    .insert(pullRequests)
    .values({
      installationId: 1,
      repo: "acme/api",
      number: 232,
      author: "bob",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    })
    .returning({ id: pullRequests.id });
  pullId = pull?.id ?? "";
});

describe("listing a PR's findings with a token", () => {
  it("lists the PR's open findings for someone who can read the repository", async () => {
    const id = await finding();
    await finding({ status: "fixed", fingerprint: "closed" });
    const response = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(READER, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { findings: { id: string }[] };
    expect(body.findings.map((f) => f.id)).toEqual([id]);
  });

  it("lists ours even when other reviewers' findings fill more than the limit", async () => {
    const ours = await finding({ severity: "nit", fingerprint: "ours" });
    // 201 blocking findings from other reviewers: sorted first, they'd take every row.
    await db.insert(findings).values(
      Array.from({ length: 201 }, (_, i) => ({
        pullRequestId: pullId,
        fingerprint: `theirs:${i}`,
        source: i % 2 === 0 ? ("human" as const) : ("bot" as const),
        sourceLogin: "zed",
        ruleCategory: "correctness",
        severity: "blocking" as const,
        title: "Theirs",
        body: "Another reviewer's.",
        path: "src/cart.ts",
        line: 4,
        side: "RIGHT" as const,
        raisedAtSha: "a".repeat(40),
      })),
    );
    const response = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(READER, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    const body = JSON.parse(response.body) as { findings: { id: string }[] };
    expect(body.findings.map((f) => f.id)).toEqual([ours]);
  });

  it("needs a token GitHub accepts", async () => {
    const response = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken("ghp_unknown_token_eeeeeeeeeeee", { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    expect(response.status).toBe(401);
    const malformed = await handleDashboardRequest(
      deps,
      request("GET", "/api/findings", withToken("not a token", { query: { repo: "acme/api" } })),
    );
    expect(malformed.status).toBe(401);
  });

  it("without a token, falls back to the session, which there isn't", async () => {
    const response = await handleDashboardRequest(
      deps,
      request("GET", "/api/findings", { query: { repo: "acme/api", pr: "232" } }),
    );
    expect(response.status).toBe(401);
  });

  it("hides a repository the token can't read, or whose owner isn't allowed", async () => {
    await finding();
    const hidden = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(STRANGER, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    expect(hidden.status).toBe(404);
    const elsewhere = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(WRITER, { query: { repo: "evil/api", pr: "232" } }),
      ),
    );
    expect(elsewhere.status).toBe(404);
    // An owner outside allowedOrgs is never asked about.
    expect(lookups.some((entry) => entry.includes("evil/api"))).toBe(false);
  });

  it("needs a repository and a PR number", async () => {
    const response = await handleDashboardRequest(
      deps,
      request("GET", "/api/findings", withToken(READER, { query: { repo: "acme/api" } })),
    );
    expect(response.status).toBe(400);
  });

  it("takes a token only on the findings endpoints", async () => {
    const response = await handleDashboardRequest(
      deps,
      request("GET", "/api/me", withToken(WRITER)),
    );
    expect(response.status).toBe(404);
  });

  it("asks GitHub once per token and repository a minute, and never logs the token", async () => {
    await finding();
    for (let i = 0; i < 3; i += 1) {
      await handleDashboardRequest(
        deps,
        request(
          "GET",
          "/api/findings",
          withToken(READER, { query: { repo: "acme/api", pr: "232" } }),
        ),
      );
    }
    expect(lookups).toEqual([
      `login:${READER}`,
      `member:${READER}:acme`,
      `access:${READER}:acme/api`,
    ]);
    expect(JSON.stringify(logged)).not.toContain(READER);
  });
});

describe("answering a finding with a token", () => {
  it("records a fix claim for the recheck without closing the finding", async () => {
    const id = await finding();
    const response = await ack(id, WRITER, { outcome: "fixed" });
    expect(response.status).toBe(200);
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    expect(row?.status).toBe("open");
    expect(row?.fixClaimedBy).toBe("Carol");
    // The database's time, to the millisecond, so the recheck's copy of it matches exactly.
    expect(row?.fixClaimedAt?.getUTCMilliseconds()).toBeTypeOf("number");
    const events = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect(events.map((event) => [event.type, event.actorLogin])).toEqual([
      ["fix_claimed", "Carol"],
    ]);
    // The recheck sees the claim.
    const tracked = await drizzleFindingStore(db).trackedFindings(pullId);
    expect(tracked.find((record) => record.id === id)?.fixClaimedAt).toBe(
      row?.fixClaimedAt?.toISOString(),
    );
  });

  it("keeps a claim made again after the run's recheck looked, and clears the one it saw", async () => {
    const id = await finding();
    await ack(id, WRITER, { outcome: "fixed" });
    const store = drizzleFindingStore(db);
    const seen = (await store.trackedFindings(pullId))[0]?.fixClaimedAt ?? "";
    // The run saw an earlier claim: this one is newer, so it stays.
    await store.clearFixClaims?.([{ findingId: id, fixClaimedAt: "2026-11-23T09:00:00.000Z" }]);
    expect((await store.trackedFindings(pullId))[0]?.fixClaimedAt).toBe(seen);
    await store.clearFixClaims?.([{ findingId: id, fixClaimedAt: seen }]);
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    expect([row?.status, row?.fixClaimedAt, row?.fixClaimedBy]).toEqual(["open", null, null]);
  });

  it("declines with the reason, and queues it for outcome learning", async () => {
    const id = await finding();
    const response = await ack(id, WRITER, {
      outcome: "declined",
      reason: "The note is kept upstream.",
    });
    expect(response.status).toBe(200);
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    expect(row?.status).toBe("declined");
    const [event] = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect(event).toMatchObject({
      type: "declined",
      actor: "human",
      actorLogin: "Carol",
      reason: "The note is kept upstream.",
      learnPending: true,
    });
    // The reason is never logged.
    expect(JSON.stringify(logged)).not.toContain("kept upstream");
    // The reconciler learns from it once, then it's read.
    const rejected: { repo: string; ids: string[] }[] = [];
    const learn = {
      store: drizzleAnswerLearningStore(db),
      rejected: async (
        _installation: number,
        repo: string,
        list: readonly { findingId: string }[],
      ) => {
        rejected.push({ repo, ids: list.map((entry) => entry.findingId) });
      },
      log: () => undefined,
    };
    expect(await learnFromAnswers(learn)).toBe(1);
    expect(await learnFromAnswers(learn)).toBe(0);
    expect(rejected).toEqual([{ repo: "acme/api", ids: [id] }]);
  });

  it("stores a decline's reason as a reply's body is: with secrets redacted", async () => {
    const id = await finding({ fingerprint: "secret" });
    const token = `ghp_${"a".repeat(36)}`;
    const answered = await ack(id, WRITER, {
      outcome: "declined",
      reason: `The test uses ${token} on purpose, password = "hunter22"`,
    });
    expect(answered.status).toBe(200);
    const [event] = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect(event?.reason).not.toContain(token);
    expect(event?.reason).not.toContain("hunter22");
    expect(event?.reason).toContain("[redacted token]");
  });

  it("caps a reason redaction made longer, rather than failing the decline", async () => {
    const id = await finding({ fingerprint: "long" });
    // 90 secrets, each of which redaction lengthens: 1997 characters in, far more after.
    const reason = 'password = "hunter22" '.repeat(90) + "x".repeat(17);
    expect(reason.length).toBe(1997);
    const answered = await ack(id, WRITER, { outcome: "declined", reason });
    expect(answered.status).toBe(200);
    const [event] = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect(event?.reason?.length).toBeLessThanOrEqual(2000);
    expect(event?.reason).not.toContain("hunter22");
  });

  it("takes a reason of control characters, which JSON-encoding makes six times longer", async () => {
    const id = await finding({ fingerprint: "escaped" });
    const reason = `${"\u001b".repeat(1999)}x`;
    expect(JSON.stringify({ outcome: "declined", reason }).length).toBeGreaterThan(8192);
    const answered = await ack(id, WRITER, { outcome: "declined", reason });
    expect(answered.status).toBe(200);
  });

  it("turns the database's own refusal of an answer into AnswerRefusedError", async () => {
    const id = await finding({ fingerprint: "refused" });
    await expect(deps.store.declineFinding(id, "", "a reason")).rejects.toBeInstanceOf(
      AnswerRefusedError,
    );
    await expect(deps.store.claimFix(id, "")).rejects.toThrow(/login/);
  });

  it("refuses a NUL in a reason with 400, and never puts a reason in a database error", async () => {
    const id = await finding({ fingerprint: "nul" });
    const answered = await ack(id, WRITER, { outcome: "declined", reason: "a\u0000b" });
    expect(answered.status).toBe(400);
    // Any other database failure is rethrown without the query's parameters.
    const failure = await deps.store
      .declineFinding("not-a-uuid", "secret-login", "a secret reason")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).not.toMatch(/secret/);
    expect(JSON.stringify(failure)).not.toMatch(/secret/);
  });

  it("says a renamed or transferred repository has moved", async () => {
    const response = await handleDashboardRequest(
      deps,
      request("GET", "/api/findings", withToken(MOVED, { query: { repo: "acme/api", pr: "232" } })),
    );
    expect(response.status).toBe(404);
    expect(response.body).toContain("has moved");
  });

  it("keeps a decline pending when learning failed on it, and gives it up after five", async () => {
    const id = await finding({ fingerprint: "half" });
    await ack(id, WRITER, { outcome: "declined", reason: "nope" });
    // Learning doesn't throw: it says it failed on this finding.
    const failingOne = {
      store: drizzleAnswerLearningStore(db),
      rejected: async (_i: number, _r: string, list: readonly { findingId: string }[]) =>
        list.map((entry) => ({ findingId: entry.findingId, skipped: "failed" })),
      log: () => undefined,
    };
    expect(await learnFromAnswers(failingOne)).toBe(0);
    let [event] = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect([event?.learnPending, event?.learnAttempts]).toEqual([true, 1]);
    for (let i = 0; i < 4; i += 1) await learnFromAnswers(failingOne);
    [event] = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect([event?.learnPending, event?.learnAttempts]).toEqual([false, 5]);
  });

  it("gives up on a decline whose learning keeps failing, without holding up the rest", async () => {
    const stuck = await finding({ fingerprint: "stuck" });
    await ack(stuck, WRITER, { outcome: "declined", reason: "uninstalled" });
    const failing = {
      store: drizzleAnswerLearningStore(db),
      rejected: async () => {
        throw new Error("no installation");
      },
      log: (message: string) => logged.push({ message }),
    };
    for (let i = 0; i < 5; i += 1) expect(await learnFromAnswers(failing)).toBe(0);
    expect(logged.map((entry) => entry.message)).toContain(
      "answers given up on: outcome learning kept failing",
    );
    const [event] = await db.select().from(findingEvents).where(eq(findingEvents.findingId, stuck));
    expect([event?.learnPending, event?.learnAttempts]).toEqual([false, 5]);
    // A newer decline is read first even while an older one is still failing.
    const older = await finding({ fingerprint: "older" });
    await ack(older, WRITER, { outcome: "declined", reason: "a" });
    await learnFromAnswers(failing);
    const newer = await finding({ fingerprint: "newer" });
    await ack(newer, WRITER, { outcome: "declined", reason: "b" });
    const order = await drizzleAnswerLearningStore(db).pendingAnswers(10);
    expect(order.map((answer) => answer.findingId)).toEqual([newer, older]);
  });

  it("needs write access to answer, and a reason to decline", async () => {
    const id = await finding();
    expect((await ack(id, READER, { outcome: "fixed" })).status).toBe(403);
    expect((await ack(id, STRANGER, { outcome: "fixed" })).status).toBe(404);
    expect((await ack(id, WRITER, { outcome: "declined" })).status).toBe(400);
    expect((await ack(id, WRITER, { outcome: "declined", reason: " " })).status).toBe(400);
    expect((await ack(id, WRITER, { outcome: "resolved" })).status).toBe(400);
    const broken = await handleDashboardRequest(
      deps,
      request("POST", `/api/findings/${id}/ack`, withToken(WRITER, { body: "{" })),
    );
    expect(broken.status).toBe(400);
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    expect(row?.status).toBe("open");
  });

  it("won't let the PR's author decline a blocking or protected finding", async () => {
    const blocking = await finding({ severity: "blocking", fingerprint: "b" });
    const money = await finding({ ruleCategory: "money", fingerprint: "m" });
    const nit = await finding({ severity: "nit", fingerprint: "n" });
    const why = { outcome: "declined", reason: "fine" };
    expect((await ack(blocking, AUTHOR, why)).status).toBe(403);
    expect((await ack(money, AUTHOR, why)).status).toBe(403);
    expect((await ack(nit, AUTHOR, why)).status).toBe(200);
    // The author may still say a blocking one is fixed: only the recheck closes it.
    expect((await ack(blocking, AUTHOR, { outcome: "fixed" })).status).toBe(200);
    // Someone else with write access may decline it.
    expect((await ack(blocking, WRITER, why)).status).toBe(200);
  });

  it("answers only open or outdated findings of ours", async () => {
    const closed = await finding({ status: "fixed", fingerprint: "c" });
    const theirs = await finding({ source: "human", sourceLogin: "zed", fingerprint: "h" });
    expect((await ack(closed, WRITER, { outcome: "fixed" })).status).toBe(409);
    expect((await ack(theirs, WRITER, { outcome: "fixed" })).status).toBe(409);
    expect(
      (await ack("00000000-0000-4000-8000-000000000000", WRITER, { outcome: "fixed" })).status,
    ).toBe(404);
  });
});

describe("review round 1 (NIC-1140)", () => {
  it("lets a token that can't write list, not answer", async () => {
    const id = await finding();
    const listed = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(LIMITED, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    expect(listed.status).toBe(200);
    const answered = await ack(id, LIMITED, { outcome: "fixed" });
    expect(answered.status).toBe(403);
    expect(answered.body).toContain("can't write");
  });

  const list = (token: string) =>
    handleDashboardRequest(
      deps,
      request("GET", "/api/findings", withToken(token, { query: { repo: "acme/api", pr: "232" } })),
    );

  it("remembers a refused token for ten minutes", async () => {
    const bad = "ghp_unknown_token_000000000000";
    expect((await list(bad)).status).toBe(401);
    expect((await list(bad)).status).toBe(401);
    // GitHub was asked once: the refusal is remembered by the token's hash.
    expect(lookups.filter((entry) => entry === `login:${bad}`)).toHaveLength(1);
    now = new Date(NOW.getTime() + 11 * 60_000);
    expect((await list(bad)).status).toBe(401);
    expect(lookups.filter((entry) => entry === `login:${bad}`)).toHaveLength(2);
  });

  it("keeps a verified login an hour after it was last used, and permissions for a minute", async () => {
    const at = (minutes: number) => {
      now = new Date(NOW.getTime() + minutes * 60_000);
    };
    const logins = () => lookups.filter((entry) => entry === `login:${READER}`).length;
    await list(READER);
    at(2);
    await list(READER);
    // Membership and access read again after a minute; the login isn't.
    expect(logins()).toBe(1);
    expect(lookups.filter((entry) => entry === `access:${READER}:acme/api`)).toHaveLength(2);
    // Used every 50 minutes, it never expires.
    at(52);
    await list(READER);
    at(102);
    await list(READER);
    expect(logins()).toBe(1);
    // Left alone for over an hour, it's looked up again.
    at(170);
    await list(READER);
    expect(logins()).toBe(2);
  });

  it("rejects a malformed token cheaply, counting it nowhere", async () => {
    for (let i = 0; i < 150; i += 1) expect((await list("not a token")).status).toBe(401);
    expect(lookups).toEqual([]);
    expect((await list(WRITER)).status).toBe(200);
  });

  it("says when a token can't read org membership", async () => {
    const response = await list(NO_READ_ORG);
    expect(response.status).toBe(403);
    expect(response.body).toContain("read:org");
    expect(response.body).toContain("Members permission");
  });

  it("tells an installation token to use a person's", async () => {
    const response = await list("ghs_installation_token_llllllll");
    expect(response.status).toBe(401);
    expect(response.body).toContain("installation token");
    expect(lookups).toEqual([]);
  });

  it("lists nothing to someone outside the org, even on a public repository", async () => {
    await finding({ ruleCategory: "secrets", fingerprint: "s" });
    const response = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(OUTSIDER, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    expect(response.status).toBe(404);
    expect(lookups).toContain(`member:${OUTSIDER}:acme`);
  });

  it("says why GitHub refused, or that it couldn't be asked", async () => {
    const id = await finding();
    for (const [token, status, text] of [
      [SSO, 403, "single sign-on"],
      [FORBIDDEN, 403, "IP allow list"],
      [DOWN, 503, "couldn't be asked"],
      [LIMITED_RATE, 503, "rate limit"],
    ] as const) {
      const response = await ack(id, token, { outcome: "fixed" });
      expect(response.status).toBe(status);
      expect(response.body).toContain(text);
    }
  });

  it("won't take a fix claim the recheck can't check", async () => {
    const left = await finding({ side: "LEFT", fingerprint: "left" });
    const wide = await finding({ path: null, line: null, side: null, fingerprint: "wide" });
    for (const id of [left, wide]) {
      const response = await ack(id, WRITER, { outcome: "fixed" });
      expect(response.status).toBe(409);
      expect(response.body).toContain("a recheck can't check this finding");
    }
    // It can still be declined.
    expect((await ack(left, WRITER, { outcome: "declined", reason: "old code" })).status).toBe(200);
  });

  it("lists a PR's outdated findings too, with their status", async () => {
    await finding({ status: "outdated", fingerprint: "o" });
    const response = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(READER, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    expect(JSON.parse(response.body)).toMatchObject({ findings: [{ status: "outdated" }] });
  });

  it("says which findings can be marked fixed, so the CLI's markdown can say so (NIC-1142)", async () => {
    const right = await finding({ fingerprint: "right" });
    const left = await finding({ side: "LEFT", fingerprint: "left-listed" });
    const response = await handleDashboardRequest(
      deps,
      request(
        "GET",
        "/api/findings",
        withToken(READER, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    const { findings: listed } = JSON.parse(response.body) as {
      findings: { id: string; recheckable: boolean }[];
    };
    const flag = (id: string) => listed.find((entry) => entry.id === id)?.recheckable;
    expect(flag(right)).toBe(true);
    expect(flag(left)).toBe(false);
  });
});

describe("answering a finding with the dashboard's session", () => {
  async function signIn(): Promise<Record<string, string>> {
    const started = await handleDashboardRequest(deps, request("GET", "/api/auth/login"));
    const state = new URL(started.headers.location ?? "").searchParams.get("state") ?? "";
    const signInCookie = (started.cookies[0] ?? "").split(";")[0]?.split("=").slice(1).join("=");
    const back = await handleDashboardRequest(
      deps,
      request("GET", CALLBACK_PATH, {
        query: { code: "c", state },
        cookies: { [SIGN_IN_COOKIE]: signInCookie ?? "" },
      }),
    );
    const session =
      back.cookies
        .find((entry) => entry.startsWith(`${SESSION_COOKIE}=`))
        ?.split(";")[0]
        ?.slice(SESSION_COOKIE.length + 1) ?? "";
    return { [SESSION_COOKIE]: session };
  }

  it("answers with the session's write access, from the dashboard's own origin", async () => {
    const id = await finding();
    const cookies = await signIn();
    const crossSite = await handleDashboardRequest(
      deps,
      request("POST", `/api/findings/${id}/ack`, {
        cookies,
        body: JSON.stringify({ outcome: "fixed" }),
      }),
    );
    expect(crossSite.status).toBe(403);
    const response = await handleDashboardRequest(
      deps,
      request("POST", `/api/findings/${id}/ack`, {
        cookies,
        headers: { origin: ORIGIN },
        body: JSON.stringify({ outcome: "fixed" }),
      }),
    );
    expect(response.status).toBe(200);
    const listed = await handleDashboardRequest(
      deps,
      request("GET", "/api/findings", { cookies, query: { repo: "acme/api", pr: "232" } }),
    );
    const body = JSON.parse(listed.body) as { findings: { id: string; fixClaimedBy?: string }[] };
    expect(body.findings).toMatchObject([{ id, fixClaimedBy: "Alice" }]);
  });
});

describe("fix claims and shadow mode (NIC-1140, NIC-1141)", () => {
  const sha = (c: string) => c.repeat(40);
  const runs = drizzleRunStore(db);
  const startRun = (arn: string) =>
    runs.startRun({
      installationId: 1,
      repo: "acme/api",
      number: 232,
      author: "bob",
      headSha: sha("a"),
      baseSha: sha("b"),
      executionArn: arn,
    });
  /** A finding raised by a run in shadow mode, never posted. */
  async function shadowFinding(fingerprint: string): Promise<string> {
    const run = await startRun(`arn:exec:${fingerprint}`);
    await runs.recordShadow?.(run.runId, true);
    return finding({ runId: run.runId, fingerprint });
  }
  const live: DashboardDeps = { ...deps, store: drizzleDashboardStore(db, { live: true }) };
  const list = async (with_: DashboardDeps) => {
    const response = await handleDashboardRequest(
      with_,
      request(
        "GET",
        "/api/findings",
        withToken(READER, { query: { repo: "acme/api", pr: "232" } }),
      ),
    );
    return (JSON.parse(response.body) as { findings: { id: string }[] }).findings.map(
      (listed) => listed.id,
    );
  };

  it("retires a shadow finding whose fix claim the recheck rejected, once live", async () => {
    const id = await shadowFinding("claimed");
    // Claimed in shadow mode.
    expect((await ack(id, WRITER, { outcome: "fixed" })).status).toBe(200);
    // The recheck found it still there: the claim is cleared, and the finding stays open.
    const store = drizzleFindingStore(db);
    const claimedAt = (await store.trackedFindings(pullId))[0]?.fixClaimedAt ?? "";
    await store.clearFixClaims?.([{ findingId: id, fixClaimedAt: claimedAt }]);
    // A claim isn't an answer: still unposted and unanswered, so live, it's retired.
    expect((await store.trackedFindings(pullId))[0]?.unpostedShadow).toBe(true);
    expect(await store.retireShadowFindings?.(pullId, sha("c"))).toBe(1);
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    expect(row?.status).toBe("shadow");
  });

  it("live, won't answer an unposted shadow finding the list hides", async () => {
    const id = await shadowFinding("hidden");
    const posted = await finding({ fingerprint: "posted", githubCommentId: 77 });
    expect(await list(deps)).toEqual(expect.arrayContaining([id, posted]));
    expect(await list(live)).toEqual([posted]);
    for (const body of [{ outcome: "fixed" }, { outcome: "declined", reason: "intended" }]) {
      const response = await handleDashboardRequest(
        live,
        request(
          "POST",
          `/api/findings/${id}/ack`,
          withToken(WRITER, { body: JSON.stringify(body) }),
        ),
      );
      expect(response.status).toBe(404);
    }
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    expect([row?.status, row?.fixClaimedAt]).toEqual(["open", null]);
  });

  it("drops a fix claim when the finding is raised again after closing, or unresolved", async () => {
    const store = drizzleFindingStore(db);
    const { runId } = await startRun("arn:exec:raised-again");
    const claimed = async (id: string) =>
      (await db.select().from(findings).where(eq(findings.id, id)))[0];
    // Closed as fixed with a claim still on it, then raised again: a new finding, unclaimed.
    const raised = await finding({ fingerprint: "fp:raised" });
    expect((await ack(raised, WRITER, { outcome: "fixed" })).status).toBe(200);
    await store.closeFixed?.(raised, sha("c"));
    await store.saveFindings(pullId, runId, sha("d"), [
      {
        finding: {
          rule_category: "correctness",
          severity: "should_fix",
          path: "src/cart.ts",
          line: 4,
          side: "RIGHT",
          title: "Quantity drops the note",
          body: "The merge loses the note.",
          evidence: "code",
        },
        fingerprint: "fp:raised",
      },
    ]);
    expect(await claimed(raised)).toMatchObject({
      status: "open",
      fixClaimedAt: null,
      fixClaimedBy: null,
    });
    // Still open when raised again: the claim stands, for the recheck.
    expect((await ack(raised, WRITER, { outcome: "fixed" })).status).toBe(200);
    await store.saveFindings(pullId, runId, sha("e"), [
      {
        finding: {
          rule_category: "correctness",
          severity: "should_fix",
          path: "src/cart.ts",
          line: 4,
          side: "RIGHT",
          title: "Quantity drops the note",
          body: "The merge loses the note.",
          evidence: "code",
        },
        fingerprint: "fp:raised",
      },
    ]);
    expect((await claimed(raised))?.fixClaimedBy).toBe("Carol");

    // Resolved by a person with a claim on it, then unresolved: open again, unclaimed.
    const resolved = await finding({ fingerprint: "fp:resolved", githubCommentId: 88 });
    expect((await ack(resolved, WRITER, { outcome: "fixed" })).status).toBe(200);
    await store.syncThreads(pullId, [{ resolved: true, firstCommentId: 88 }], sha("c"));
    expect((await claimed(resolved))?.status).toBe("resolved_by_human");
    await store.syncThreads(pullId, [{ resolved: false, firstCommentId: 88 }], sha("d"));
    expect(await claimed(resolved)).toMatchObject({
      status: "open",
      fixClaimedAt: null,
      fixClaimedBy: null,
    });
  });
});
