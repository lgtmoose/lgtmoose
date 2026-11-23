import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { findingEvents, findings, pullRequests } from "@lgtmoose/db";
import { MIGRATIONS_FOLDER } from "@lgtmoose/db/migrate";
import { drizzleLearningStore } from "@lgtmoose/learnings";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleFindingStore } from "./aws.js";
import { CALLBACK_PATH, handleDashboardRequest, type DashboardDeps } from "./dashboard.js";
import { TOKEN_HEADER, clearTokenCache } from "./dashboard-findings.js";
import { DashboardGitHubError, type DashboardGitHub } from "./dashboard-github.js";
import { SESSION_COOKIE, SIGN_IN_COOKIE, type DashboardRequest } from "./dashboard-http.js";
import { drizzleDashboardStore } from "./dashboard-store.js";
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

const people: Record<string, { login: string; access: "write" | "read" | "none" }> = {
  [WRITER]: { login: "Carol", access: "write" },
  [READER]: { login: "Dan", access: "read" },
  [AUTHOR]: { login: "bob", access: "write" },
  [STRANGER]: { login: "Eve", access: "none" },
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
  visibleRepos: async () => ({ repos: ["acme/api", "acme/web"], writeRepos: ["acme/api"] }),
  async repoAccess(token, repo) {
    lookups.push(`access:${token}:${repo}`);
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
  now: () => NOW,
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

beforeEach(async () => {
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
    expect(lookups).toEqual([`login:${READER}`, `access:${READER}:acme/api`]);
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
    expect(row?.fixClaimedAt?.toISOString()).toBe(NOW.toISOString());
    const events = await db.select().from(findingEvents).where(eq(findingEvents.findingId, id));
    expect(events.map((event) => [event.type, event.actorLogin])).toEqual([
      ["fix_claimed", "Carol"],
    ]);
    // The recheck sees the claim.
    const tracked = await drizzleFindingStore(db).trackedFindings(pullId);
    expect(tracked.find((record) => record.id === id)?.fixClaimedAt).toBe(NOW.toISOString());
  });

  it("keeps a claim made again after the run's recheck looked, and clears the one it saw", async () => {
    const id = await finding();
    await ack(id, WRITER, { outcome: "fixed" });
    const store = drizzleFindingStore(db);
    // The run saw an earlier claim: this one is newer, so it stays.
    await store.clearFixClaims?.([{ findingId: id, fixClaimedAt: "2026-11-23T09:00:00.000Z" }]);
    expect((await store.trackedFindings(pullId))[0]?.fixClaimedAt).toBe(NOW.toISOString());
    await store.clearFixClaims?.([{ findingId: id, fixClaimedAt: NOW.toISOString() }]);
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
