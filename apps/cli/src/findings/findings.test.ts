import { parseDeployConfig, STACK_NAMES, STACK_OUTPUTS } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { run } from "../cli.js";
import { TOKEN_HEADER, type FindingsDeps } from "./findings.js";

const ID = "0b61857d-3dc4-43e5-9bb2-6eafd3446db7";
const DASHBOARD = "https://d123.cloudfront.net";

interface Call {
  url: string;
  redirect: string | undefined;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function deps(
  options: {
    token?: string | undefined;
    deployed?: boolean;
    env?: Record<string, string>;
    reply?: { status?: number; body: unknown };
  } = {},
): { deps: FindingsDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      loadConfig: async () =>
        parseDeployConfig({
          region: "eu-west-1",
          allowedOrgs: ["acme"],
          providers: [{ id: "claude", harness: "claude-code", auth: "oauth-token" }],
        }),
      stacks: () => ({
        physicalIds: async () => [],
        describe: async (name) =>
          name === STACK_NAMES.dashboard && options.deployed !== false
            ? {
                status: "UPDATE_COMPLETE",
                outputs: { [STACK_OUTPUTS.dashboard.dashboardUrl]: DASHBOARD },
              }
            : undefined,
      }),
      env: options.env ?? {},
      githubToken: async () => ("token" in options ? options.token : "ghp_token_from_gh"),
      async fetch(url, init) {
        calls.push({
          url,
          method: init.method ?? "GET",
          redirect: init.redirect,
          headers: init.headers as Record<string, string>,
          body: init.body === undefined ? undefined : JSON.parse(init.body as string),
        });
        const reply = options.reply ?? { body: { findings: [] } };
        return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
      },
    },
  };
}

const finding = {
  id: ID,
  repo: "acme/app",
  number: 232,
  severity: "should_fix",
  ruleCategory: "correctness",
  title: "Quantity drops the note",
  body: "The merge loses the note.",
  path: "src/cart.ts",
  line: 42,
  source: "self",
  sourceLogin: undefined,
  createdAt: "2026-11-23T10:00:00.000Z",
};

const DECISION = {
  runId: "5eba8380-1111-4222-8333-444455556666",
  headSha: "abc1234def5678abc1234def5678abc1234def56",
  decision: "request_changes",
  blocking: 1,
  shouldFix: 2,
  nits: 0,
  shadow: true,
  finishedAt: "2026-11-23T10:00:00.000Z",
};

describe("lgtmoose findings: the PR's decision (NIC-1145)", () => {
  it("starts every format with the PR's latest decision", async () => {
    const { deps: d } = deps({ reply: { body: { findings: [finding], decision: DECISION } } });
    const line =
      "Latest decision: Changes requested (shadow) at abc1234 · 1 blocking · 2 should-fix · 0 nits · run 5eba8380";
    const md = await run(["findings", "acme/app#232"], { findingsDeps: async () => d });
    expect(md.stdout).toContain(line);
    expect(md.stdout).toContain("It requests changes");
    const text = await run(["findings", "acme/app#232", "--format", "text"], {
      findingsDeps: async () => d,
    });
    expect(text.stdout.split("\n")[0]).toBe(line);
    const json = await run(["findings", "acme/app#232", "--format", "json"], {
      findingsDeps: async () => d,
    });
    expect(JSON.parse(json.stdout)).toMatchObject({ decision: DECISION, findings: [{ id: ID }] });
  });

  it("says when none is recorded, and claims nothing when the dashboard gives none at all", async () => {
    const { deps: none } = deps({ reply: { body: { findings: [], decision: null } } });
    const said = await run(["findings", "acme/app#232", "--format", "text"], {
      findingsDeps: async () => none,
    });
    expect(said.stdout).toContain("Latest decision: none recorded yet.");
    // An older dashboard, or a decision it can't read (a bad commit): no line either way.
    for (const body of [
      { findings: [] },
      { findings: [], decision: { ...DECISION, headSha: "x`" } },
    ]) {
      const { deps: old } = deps({ reply: { body } });
      const quiet = await run(["findings", "acme/app#232"], { findingsDeps: async () => old });
      expect(quiet.stdout).not.toContain("Latest decision");
    }
  });
});

describe("lgtmoose runs <repo>#<pr> (NIC-1145)", () => {
  const RUN = {
    id: "5eba8380-1111-4222-8333-444455556666",
    headSha: "abc1234def5678abc1234def5678abc1234def56",
    kind: "incremental",
    status: "succeeded",
    decision: "comment",
    blocking: 0,
    shouldFix: 1,
    nits: 2,
    shadow: true,
    costUsd: 0.27,
    createdAt: "2026-11-23T09:54:00.000Z",
  };

  it("lists the PR's runs with what each decided, through the same token path", async () => {
    const started = {
      ...RUN,
      id: "85f137e3-1111-4222-8333-444455556666",
      startedAt: "2026-11-23T09:55:30.000Z",
    };
    const covered = {
      ...RUN,
      id: "24ee07af-1111-4222-8333-444455556666",
      status: "covered",
      decision: undefined,
      blocking: undefined,
      shouldFix: undefined,
      nits: undefined,
      shadow: false,
      costUsd: undefined,
    };
    const { deps: d, calls } = deps({
      reply: { body: { runs: [RUN, started, covered, { id: "bad" }] } },
    });
    const result = await run(["runs", "Acme/App#232"], { findingsDeps: async () => d });
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.url).toBe(`${DASHBOARD}/api/runs?repo=acme%2Fapp&pr=232`);
    expect(calls[0]?.headers[TOKEN_HEADER]).toBe("ghp_token_from_gh");
    expect(calls[0]?.redirect).toBe("error");
    expect(result.stdout.split("\n")).toEqual([
      "2026-11-23T09:54:00.000Z  abc1234  incremental  succeeded  Comment (0 blocking · 1 should-fix · 2 nits)  $0.27  shadow  run 5eba8380",
      // When it started, where it did.
      "2026-11-23T09:55:30.000Z  abc1234  incremental  succeeded  Comment (0 blocking · 1 should-fix · 2 nits)  $0.27  shadow  run 85f137e3",
      "2026-11-23T09:54:00.000Z  abc1234  incremental  covered  —  run 24ee07af",
      "",
    ]);
    const json = await run(["runs", "acme/app#232", "--format", "json"], {
      findingsDeps: async () => d,
    });
    expect(JSON.parse(json.stdout)).toEqual([
      RUN,
      started,
      expect.objectContaining({ status: "covered" }),
    ]);
  });

  it("passes on a refusal, and says what it needs", async () => {
    const { deps: refused } = deps({
      reply: { status: 404, body: { error: "no such repository" } },
    });
    const result = await run(["runs", "acme/app#232"], { findingsDeps: async () => refused });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no such repository");
    const { deps: d } = deps();
    expect((await run(["runs", "acme/app"], { findingsDeps: async () => d })).stderr).toContain(
      "owner/repo#123",
    );
    expect(
      (await run(["runs", "acme/app#1", "--format", "md"], { findingsDeps: async () => d })).stderr,
    ).toContain("text or json");
    expect((await run(["runs"], { findingsDeps: async () => d })).stdout).toContain("Usage:");
  });
});

describe("lgtmoose findings <repo>#<pr>", () => {
  it("lists the PR's findings as markdown for an agent, with the token in its header", async () => {
    const { deps: d, calls } = deps({
      reply: { body: { findings: [finding, { ...finding, id: "other", source: "human" }] } },
    });
    const result = await run(["findings", "Acme/App#232"], { findingsDeps: async () => d });
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.url).toBe(`${DASHBOARD}/api/findings?repo=acme%2Fapp&pr=232`);
    expect(calls[0]?.headers[TOKEN_HEADER]).toBe("ghp_token_from_gh");
    // A redirect is never followed with the token on it.
    expect(calls[0]?.redirect).toBe("error");
    expect(result.stdout).toContain("# LGTMoose findings on acme/app#232");
    expect(result.stdout).toContain(`- ID: \`${ID}\``);
    expect(result.stdout).toContain("lgtmoose findings ack <id> fixed");
    // Another reviewer's finding is answered on GitHub, not here.
    expect(result.stdout).toContain("1 open.");
  });

  it("prints JSON or a short list when asked", async () => {
    const { deps: d } = deps({ reply: { body: { findings: [finding] } } });
    const json = await run(["findings", "acme/app#232", "--format", "json"], {
      findingsDeps: async () => d,
    });
    expect(JSON.parse(json.stdout)).toMatchObject({ findings: [{ id: ID, path: "src/cart.ts" }] });
    const text = await run(["findings", "acme/app#232", "--format", "text"], {
      findingsDeps: async () => d,
    });
    expect(text.stdout).toBe(`${ID}  should_fix src/cart.ts:42  Quantity drops the note\n`);
    const { deps: escaped } = deps({
      reply: { body: { findings: [{ ...finding, title: "Bad\u001b[2J\u2028title" }] } },
    });
    const clean = await run(["findings", "acme/app#232", "--format", "text"], {
      findingsDeps: async () => escaped,
    });
    expect(clean.stdout).toContain("Bad [2J title");
    expect(clean.stdout).not.toContain("\u001b");
  });

  it("escapes control, bidi and line-separator characters in JSON, keeping it the same JSON", async () => {
    const title = "Bad\u009b31m\u202Etitle\u2028\u007f\u001b[2J";
    const { deps: d } = deps({ reply: { body: { findings: [{ ...finding, title }] } } });
    const json = await run(["findings", "acme/app#232", "--format", "json"], {
      findingsDeps: async () => d,
    });
    // Nothing raw but the layout's newlines.
    expect(json.stdout.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(json.stdout).toContain("\\u009b");
    expect(json.stdout).toContain("\\u202e");
    expect(JSON.parse(json.stdout)).toMatchObject({ findings: [{ title }] });
  });

  it("escapes both halves of a format character above U+FFFF", async () => {
    const title = "ok\u{E0041}\u{E0042}x";
    const { deps: d } = deps({ reply: { body: { findings: [{ ...finding, title }] } } });
    const json = await run(["findings", "acme/app#232", "--format", "json"], {
      findingsDeps: async () => d,
    });
    expect(json.stdout).toContain("ok\\udb40\\udc41\\udb40\\udc42x");
    expect(JSON.parse(json.stdout)).toMatchObject({ findings: [{ title }] });
  });

  it("takes the dashboard's URL from --url or the environment, localhost for compose", async () => {
    const { deps: d, calls } = deps({ env: { LGTMOOSE_DASHBOARD_URL: "http://localhost:8080/" } });
    await run(["findings", "acme/app#232"], { findingsDeps: async () => d });
    expect(calls[0]?.url.startsWith("http://localhost:8080/api/findings?")).toBe(true);
    const plain = await run(["findings", "acme/app#232", "--url", "http://dash.example.com"], {
      findingsDeps: async () => d,
    });
    expect(plain.exitCode).toBe(1);
    expect(plain.stderr).toContain("must be https://");
  });

  it("says what's missing: a target, a token, a deployed dashboard", async () => {
    const bad = await run(["findings", "acme/app"], { findingsDeps: async () => deps().deps });
    expect(bad.stderr).toContain("owner/repo#123");
    const noToken = await run(["findings", "acme/app#1"], {
      findingsDeps: async () => deps({ token: undefined }).deps,
    });
    expect(noToken.stderr).toContain("No GitHub token");
    const notDeployed = await run(["findings", "acme/app#1"], {
      findingsDeps: async () => deps({ deployed: false }).deps,
    });
    expect(notDeployed.stderr).toContain(`No deployed ${STACK_NAMES.dashboard} stack`);
  });

  it("passes on the dashboard's refusal", async () => {
    const refused = await run(["findings", "acme/app#1"], {
      findingsDeps: async () => deps({ reply: { status: 401, body: { error: "bad-token" } } }).deps,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("GitHub didn't accept your token (bad-token)");
    const hidden = await run(["findings", "acme/app#1"], {
      findingsDeps: async () =>
        deps({ reply: { status: 404, body: { error: "no such repository" } } }).deps,
    });
    expect(hidden.stderr).toContain("The dashboard refused: no such repository.");
    const down = await run(["findings", "acme/app#1"], {
      findingsDeps: async () =>
        deps({ reply: { status: 503, body: { error: "GitHub is unavailable" } } }).deps,
    });
    expect(down.stderr).toContain("couldn't be asked about your access just now");
    // A throttle: API Gateway's, or the compose server's.
    const busy = await run(["findings", "acme/app#1"], {
      findingsDeps: async () => deps({ reply: { status: 429, body: { error: "slow-down" } } }).deps,
    });
    expect(busy.stderr).toContain("The dashboard is busy");
  });
});

describe("lgtmoose findings ack", () => {
  it("says a finding is fixed", async () => {
    const { deps: d, calls } = deps({ reply: { body: { id: ID, outcome: "fixed" } } });
    const result = await run(["findings", "ack", ID.toUpperCase(), "fixed"], {
      findingsDeps: async () => d,
    });
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toMatchObject({
      url: `${DASHBOARD}/api/findings/${ID}/ack`,
      method: "POST",
      body: { outcome: "fixed" },
    });
    expect(result.stdout).toContain("checks it again first");
  });

  it("declines with a reason, and needs one", async () => {
    const { deps: d, calls } = deps({ reply: { body: { id: ID, outcome: "declined" } } });
    const result = await run(["findings", "ack", ID, "declined", "--reason", " Kept upstream. "], {
      findingsDeps: async () => d,
    });
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.body).toEqual({ outcome: "declined", reason: "Kept upstream." });
    const missing = await run(["findings", "ack", ID, "declined"], {
      findingsDeps: async () => d,
    });
    expect(missing.stderr).toContain("needs --reason");
  });

  it("refuses what it can't send", async () => {
    const d = async () => deps().deps;
    expect((await run(["findings", "ack", "f1", "fixed"], { findingsDeps: d })).stderr).toContain(
      "Usage:",
    );
    expect((await run(["findings", "ack", ID, "resolved"], { findingsDeps: d })).stderr).toContain(
      "fixed or declined",
    );
    expect(
      (await run(["findings", "ack", ID, "fixed", "--reason", "x"], { findingsDeps: d })).stderr,
    ).toContain("declined only");
    expect(
      (await run(["findings", "acme/app#1", "--format", "xml"], { findingsDeps: d })).stderr,
    ).toContain("md, json or text");
  });

  it("shows help", async () => {
    const help = await run(["findings", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("ack <id> fixed");
  });
});
