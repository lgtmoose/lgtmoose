import { parseDeployConfig, STACK_NAMES, STACK_OUTPUTS } from "@lgtmoose/config";
import { describe, expect, it } from "vitest";
import { run } from "../cli.js";
import { TOKEN_HEADER, type FindingsDeps } from "./findings.js";

const ID = "0b61857d-3dc4-43e5-9bb2-6eafd3446db7";
const DASHBOARD = "https://d123.cloudfront.net";

interface Call {
  url: string;
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

describe("lgtmoose findings <repo>#<pr>", () => {
  it("lists the PR's findings as markdown for an agent, with the token in its header", async () => {
    const { deps: d, calls } = deps({
      reply: { body: { findings: [finding, { ...finding, id: "other", source: "human" }] } },
    });
    const result = await run(["findings", "Acme/App#232"], { findingsDeps: async () => d });
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.url).toBe(`${DASHBOARD}/api/findings?repo=acme%2Fapp&pr=232`);
    expect(calls[0]?.headers[TOKEN_HEADER]).toBe("ghp_token_from_gh");
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
    expect(JSON.parse(json.stdout)).toMatchObject([{ id: ID, path: "src/cart.ts" }]);
    const text = await run(["findings", "acme/app#232", "--format", "text"], {
      findingsDeps: async () => d,
    });
    expect(text.stdout).toBe(`${ID}  should_fix src/cart.ts:42  Quantity drops the note\n`);
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
