import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HELP, PLAN_CREDENTIAL_WARNING, runAuth, type AuthDeps } from "./auth.js";
import type { ModelAccess } from "./bedrock.js";
import type { CredentialLabel, CredentialStore, StoredCredential } from "./credential-store.js";
import type { InteractiveRunner } from "./process.js";

const CONFIG_PATH = "/repo/lgtmoose.config.ts";
const OAUTH = "sk-ant-oat01-SECRET-OAUTH";
const ANTHROPIC_KEY = "sk-ant-api03-SECRET-KEY";
const AUTH_JSON = JSON.stringify({
  tokens: { refresh_token: "SECRET-REFRESH", access_token: "SECRET-ACCESS" },
});

const baseConfig = {
  region: "eu-west-2",
  allowedOrgs: ["acme"],
  providers: [
    { id: "claude", harness: "claude-code", auth: "oauth-token" },
    { id: "codex", harness: "codex", auth: "chatgpt-login" },
    { id: "anthropic", harness: "claude-code", auth: "api-key" },
    { id: "cursor", harness: "cursor-agent", auth: "service-account" },
    { id: "bedrock", harness: "claude-code", auth: "bedrock" },
  ],
};

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "lgtmoose-auth-test-"));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function harness(
  options: {
    config?: unknown;
    answers?: string[];
    confirm?: boolean;
    run?: InteractiveRunner;
    stored?: StoredCredential[];
    models?: ModelAccess[];
    removeOutcome?: "scheduled" | "missing";
  } = {},
) {
  const puts: { label: CredentialLabel; value: string }[] = [];
  const removed: { providerId: string; days: number }[] = [];
  const out: string[] = [];
  const answers = [...(options.answers ?? [])];
  const validated: (true | string)[] = [];
  const confirms: string[] = [];
  const store: CredentialStore = {
    put: (label, value) => {
      puts.push({ label, value });
      return Promise.resolve("created");
    },
    list: () => Promise.resolve(options.stored ?? []),
    remove: (providerId, days) => {
      removed.push({ providerId, days });
      return Promise.resolve(options.removeOutcome ?? "scheduled");
    },
  };
  const run = vi.fn<InteractiveRunner>(options.run ?? (() => Promise.resolve(0)));
  const deps: AuthDeps = {
    configPath: CONFIG_PATH,
    files: {
      exists: () => Promise.resolve(options.config !== null),
      loadConfig: () => Promise.resolve(options.config ?? baseConfig),
    },
    prompter: {
      password: ({ validate }) => {
        // Keep asking, as inquirer does, until the answer passes validation.
        for (;;) {
          const answer = answers.shift();
          if (answer === undefined) return Promise.reject(new Error("no more answers"));
          const verdict = validate?.(answer) ?? true;
          validated.push(verdict);
          if (verdict === true) return Promise.resolve(answer);
        }
      },
      confirm: ({ message }) => {
        confirms.push(message);
        return Promise.resolve(options.confirm ?? true);
      },
    },
    credentials: () => store,
    bedrock: () => ({ anthropicModels: () => Promise.resolve(options.models ?? []) }),
    run,
    trapSignals: () => () => {},
    tmpRoot,
    out: (text) => out.push(text),
  };
  const go = async (argv: string[]) => {
    const result = await runAuth(argv, () => Promise.resolve(deps));
    return { ...result, all: [...out, result.stdout, result.stderr].join("") };
  };
  return { go, puts, removed, out, run, validated, confirms };
}

const SECRETS = [OAUTH, ANTHROPIC_KEY, "SECRET-REFRESH", "SECRET-ACCESS", "SECRET-CURSOR"];
function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("auth", () => {
  it("prints help and rejects unknown methods and stray flags before building deps", async () => {
    const getDeps = vi.fn();
    expect((await runAuth(["--help"], getDeps)).stdout).toBe(AUTH_HELP);
    expect((await runAuth([], getDeps)).exitCode).toBe(1);
    const unknown = await runAuth(["vertex"], getDeps);
    expect(unknown.stderr).toContain('Unknown auth method "vertex"');
    const stray = await runAuth(["cursor", "--paste"], getDeps);
    expect(stray.stderr).toContain("auth cursor doesn't take --paste");
    const extra = await runAuth(["list", "more"], getDeps);
    expect(extra.stderr).toContain('Unexpected argument "more"');
    expect((await runAuth(["remove"], getDeps)).stderr).toContain("needs the provider id");
    expect((await runAuth(["remove", "../x"], getDeps)).stderr).toContain("isn't a provider id");
    expect((await runAuth(["cursor", "--id", "A"], getDeps)).stderr).toContain(
      "isn't a provider id",
    );
    const vendor = await runAuth(["api-key", "--provider", "google"], getDeps);
    expect(vendor.stderr).toContain("--provider anthropic or --provider openai");
    expect(getDeps).not.toHaveBeenCalled();
  });

  it("claude: warns, confirms, runs setup-token, then stores the pasted token", async () => {
    const h = harness({ answers: [ANTHROPIC_KEY, "not a token", `  ${OAUTH}\n`] });
    const result = await h.go(["claude"]);
    expect(result.exitCode).toBe(0);
    expect(h.out.join("")).toContain(PLAN_CREDENTIAL_WARNING);
    expect(h.confirms).toHaveLength(1);
    expect(h.run).toHaveBeenCalledWith("claude", ["setup-token"], {});
    expect(h.validated.slice(0, 2)).toEqual([
      expect.stringContaining("auth api-key --provider anthropic"),
      expect.stringContaining("spaces"),
    ]);
    expect(h.puts).toEqual([
      {
        label: { providerId: "claude", harness: "claude-code", auth: "oauth-token" },
        value: OAUTH,
      },
    ]);
    expect(result.stdout).toContain("lgtmoose/provider/claude (eu-west-2)");
    expectNoSecrets(result.all);
  });

  it("claude: stores nothing when the person doesn't accept the terms", async () => {
    const h = harness({ confirm: false, answers: [OAUTH] });
    const result = await h.go(["claude"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Nothing stored");
    expect(h.run).not.toHaveBeenCalled();
    expect(h.puts).toEqual([]);
  });

  it("claude --paste --accept-vendor-terms skips the login and the question", async () => {
    const h = harness({ answers: [OAUTH] });
    const result = await h.go(["claude", "--paste", "--accept-vendor-terms"]);
    expect(result.exitCode).toBe(0);
    expect(h.out.join("")).toContain(PLAN_CREDENTIAL_WARNING);
    expect(h.confirms).toEqual([]);
    expect(h.run).not.toHaveBeenCalled();
    expect(h.puts).toHaveLength(1);
  });

  it("claude: a failed setup-token stores nothing", async () => {
    const h = harness({ run: () => Promise.resolve(1), answers: [OAUTH] });
    const result = await h.go(["claude"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("exited with code 1");
    expect(h.puts).toEqual([]);
  });

  it("codex: uploads auth.json from a temporary CODEX_HOME, then deletes it", async () => {
    let home: string | undefined;
    const h = harness({
      run: async (command, args, { env }) => {
        expect(command).toBe("codex");
        expect(args).toEqual(["login", "--device-auth"]);
        home = env?.CODEX_HOME;
        await writeFile(join(home ?? "", "auth.json"), AUTH_JSON);
        return 0;
      },
    });
    const result = await h.go(["codex", "--device-auth", "--accept-vendor-terms"]);
    expect(result.exitCode).toBe(0);
    expect(h.puts).toEqual([
      { label: { providerId: "codex", harness: "codex", auth: "chatgpt-login" }, value: AUTH_JSON },
    ]);
    expect(home?.startsWith(tmpRoot)).toBe(true);
    expect(await readdir(tmpRoot)).toEqual([]);
    expectNoSecrets(result.all);
  });

  it("codex --access-token pastes a token for an access-token provider", async () => {
    const config = {
      ...baseConfig,
      providers: [{ id: "codex", harness: "codex", auth: "access-token" }],
    };
    const h = harness({ config, answers: ["SECRET-ACCESS"] });
    const result = await h.go(["codex", "--access-token"]);
    expect(result.exitCode).toBe(0);
    // An access token isn't a plan credential, so no warning or question.
    expect(h.confirms).toEqual([]);
    expect(h.out.join("")).not.toContain(PLAN_CREDENTIAL_WARNING);
    expect(h.puts[0]?.label.auth).toBe("access-token");
  });

  it("cursor: stores a service-account key", async () => {
    const h = harness({ answers: ["SECRET-CURSOR"] });
    const result = await h.go(["cursor"]);
    expect(result.exitCode).toBe(0);
    expect(h.puts[0]).toEqual({
      label: { providerId: "cursor", harness: "cursor-agent", auth: "service-account" },
      value: "SECRET-CURSOR",
    });
    expectNoSecrets(result.all);
  });

  it("api-key: needs --provider, and checks the key's shape", async () => {
    expect((await harness().go(["api-key"])).stderr).toContain("--provider anthropic");
    const h = harness({ answers: [OAUTH, ANTHROPIC_KEY] });
    const result = await h.go(["api-key", "--provider", "anthropic"]);
    expect(result.exitCode).toBe(0);
    expect(h.validated[0]).toContain("auth claude --paste");
    expect(h.puts[0]?.label.providerId).toBe("anthropic");
    expect(h.puts[0]?.value).toBe(ANTHROPIC_KEY);
  });

  it("api-key --provider openai says how to add a provider when none fits", async () => {
    const h = harness();
    const result = await h.go(["api-key", "--provider", "openai"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('harness: "codex", auth: "api-key"');
    expect(h.puts).toEqual([]);
  });

  it("asks for --id when several providers fit, and checks the one it names", async () => {
    const config = {
      ...baseConfig,
      providers: [
        { id: "claude-a", harness: "claude-code", auth: "api-key" },
        { id: "sdk", harness: "agent-sdk", auth: "api-key" },
      ],
    };
    const several = await harness({ config }).go(["api-key", "--provider", "anthropic"]);
    expect(several.stderr).toContain("claude-a, sdk");
    const wrong = await harness({ config }).go(["cursor", "--id", "sdk"]);
    expect(wrong.stderr).toContain('Provider "sdk" uses agent-sdk with api-key auth');
    const unknown = await harness({ config }).go(["cursor", "--id", "nope"]);
    expect(unknown.stderr).toContain('no provider with id "nope"');
    const h = harness({ config, answers: [ANTHROPIC_KEY] });
    const named = await h.go(["api-key", "--provider", "anthropic", "--id", "sdk"]);
    expect(named.exitCode).toBe(0);
    expect(h.puts[0]?.label).toEqual({ providerId: "sdk", harness: "agent-sdk", auth: "api-key" });
  });

  it("says to run setup when there's no config", async () => {
    const result = await harness({ config: null }).go(["list"]);
    expect(result.stderr).toContain("Run pnpm lgtmoose setup first");
  });

  it("treats Ctrl+C at a prompt as a cancel", async () => {
    const h = harness();
    const cancel = Object.assign(new Error("cancelled"), { name: "ExitPromptError" });
    const result = await runAuth(["cursor"], async () => {
      const deps = await Promise.resolve({
        configPath: CONFIG_PATH,
        files: { exists: async () => true, loadConfig: async () => baseConfig },
        prompter: { password: () => Promise.reject(cancel), confirm: async () => true },
        credentials: () => {
          throw new Error("unused");
        },
        bedrock: () => {
          throw new Error("unused");
        },
        run: h.run,
        trapSignals: () => () => {},
        out: () => {},
      } satisfies AuthDeps);
      return deps;
    });
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("Nothing stored");
  });

  it("bedrock: lists model access and stores nothing", async () => {
    const h = harness({
      models: [
        {
          modelId: "anthropic.b",
          name: "B",
          usable: false,
          problems: ["model access not granted"],
        },
        { modelId: "anthropic.a", name: "A", usable: true, problems: [] },
      ],
    });
    const result = await h.go(["bedrock"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ok {7}anthropic\.a\n {2}blocked {2}anthropic\.b: model access/);
    expect(result.stdout).toContain("needs no stored secret");
    expect(h.puts).toEqual([]);
  });

  it("bedrock: fails when no model is usable, and suggests adding a provider", async () => {
    const config = { ...baseConfig, providers: [baseConfig.providers[0]] };
    const result = await harness({
      config,
      models: [{ modelId: "anthropic.a", name: "A", usable: false, problems: ["x"] }],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Request model access");
    expect(result.stderr).toContain('auth: "bedrock"');
  });

  it("list: shows each provider's state and stored secrets no provider uses", async () => {
    const stored: StoredCredential[] = [
      {
        name: "lgtmoose/provider/claude",
        providerId: "claude",
        harness: "claude-code",
        auth: "oauth-token",
        lastChanged: new Date("2026-11-01T10:00:00Z"),
      },
      {
        name: "lgtmoose/provider/codex",
        providerId: "codex",
        harness: "codex",
        auth: "api-key",
        lastChanged: undefined,
      },
      {
        name: "lgtmoose/provider/old",
        providerId: "old",
        harness: "codex",
        auth: "api-key",
        lastChanged: undefined,
      },
    ];
    const result = await harness({ stored }).go(["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claude-code/oauth-token  stored, changed 2026-11-01");
    expect(result.stdout).toContain("stored for codex/api-key, not codex/chatgpt-login");
    expect(result.stdout).toMatch(/anthropic .*missing/);
    expect(result.stdout).toMatch(/bedrock .*no secret needed/);
    expect(result.stdout).toContain("lgtmoose/provider/old (codex/api-key)");
  });

  it("remove: confirms, warns when the provider is still configured, and schedules deletion", async () => {
    const h = harness();
    const result = await h.go(["remove", "claude"]);
    expect(result.exitCode).toBe(0);
    expect(h.out.join("")).toContain('Provider "claude" is still in lgtmoose.config.ts');
    expect(h.confirms).toEqual(["Delete lgtmoose/provider/claude in eu-west-2?"]);
    expect(h.removed).toEqual([{ providerId: "claude", days: 7 }]);
    expect(result.stdout).toContain("in 7 days");
  });

  it("remove: --yes skips the question; a missing secret fails; no means nothing deleted", async () => {
    const yes = harness();
    expect((await yes.go(["remove", "old", "--yes"])).exitCode).toBe(0);
    expect(yes.confirms).toEqual([]);
    const missing = await harness({ removeOutcome: "missing" }).go(["remove", "old", "-y"]);
    expect(missing.stderr).toContain("doesn't exist");
    const no = harness({ confirm: false });
    expect((await no.go(["remove", "old"])).stderr).toContain("Nothing deleted");
    expect(no.removed).toEqual([]);
  });
});
