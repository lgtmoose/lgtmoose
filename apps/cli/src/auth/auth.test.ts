import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_HELP, PLAN_CREDENTIAL_WARNING, runAuth, type AuthDeps } from "./auth.js";
import type { ModelAccess } from "./bedrock.js";
import type {
  CredentialLabel,
  CredentialStore,
  PutResult,
  RemoveResult,
  StoredCredential,
} from "./credential-store.js";
import { CommandNotFound, type InteractiveRunner } from "./process.js";

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
    remove?: RemoveResult;
    put?: PutResult;
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
      return Promise.resolve(options.put ?? { outcome: "created" });
    },
    list: () => Promise.resolve(options.stored ?? []),
    remove: (providerId, days) => {
      removed.push({ providerId, days });
      return Promise.resolve(options.remove ?? { status: "scheduled" });
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

  it("says how to install a missing vendor CLI", async () => {
    const missing = (name: string) => () =>
      Promise.reject(new CommandNotFound(`${name} isn't installed, or isn't on your PATH.`));
    const claude = await harness({ run: missing("claude") }).go(["claude"]);
    expect(claude.stderr).toContain("Install Claude Code, or paste a token with --paste");
    const codex = await harness({ run: missing("codex") }).go(["codex"]);
    expect(codex.stderr).toContain("npm install -g @openai/codex");
    expect(await readdir(tmpRoot)).toEqual([]);
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
    // A Codex access token belongs to a ChatGPT plan, so it gets the warning and question.
    expect(h.confirms).toHaveLength(1);
    expect(h.out.join("")).toContain(PLAN_CREDENTIAL_WARNING);
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
    // A service-account key belongs to the team, so no plan warning.
    expect(h.confirms).toEqual([]);
    expectNoSecrets(result.all);
  });

  it("cursor: a user API key bills to a personal plan, so it gets the warning", async () => {
    const config = {
      ...baseConfig,
      providers: [{ id: "cursor", harness: "cursor-agent", auth: "api-key" }],
    };
    const declined = harness({ config, confirm: false, answers: ["SECRET-CURSOR"] });
    expect((await declined.go(["cursor"])).stderr).toContain("Nothing stored");
    expect(declined.out.join("")).toContain(PLAN_CREDENTIAL_WARNING);
    expect(declined.puts).toEqual([]);
    const accepted = harness({ config, answers: ["SECRET-CURSOR"] });
    expect((await accepted.go(["cursor", "--accept-vendor-terms"])).exitCode).toBe(0);
    expect(accepted.confirms).toEqual([]);
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

  const model = (modelId: string, usable = true, callerAuthorized = true): ModelAccess => ({
    modelId,
    name: modelId,
    usable,
    problems: usable ? [] : ["model access not granted"],
    callerAuthorized,
  });
  const allTiers = [
    model("anthropic.claude-3-5-haiku-20241022-v1:0"),
    model("anthropic.claude-sonnet-4-5-20250929-v1:0"),
    model("anthropic.claude-opus-4-1-20250805-v1:0"),
  ];

  it("bedrock: checks each configured tier's model and stores nothing", async () => {
    const h = harness({ models: [...allTiers, model("anthropic.claude-instant-v1", false)] });
    const result = await h.go(["bedrock"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "  blocked  anthropic.claude-instant-v1: model access not granted",
    );
    expect(result.stdout).toContain(
      "  ok       bedrock standard (sonnet): newest: anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(result.stdout).toContain("needs no stored secret");
    expect(h.puts).toEqual([]);
  });

  it("bedrock: fails when a tier's newest model isn't usable, though another model is", async () => {
    const models = [
      ...allTiers,
      model("anthropic.claude-opus-4-5-20251101-v1:0", false),
      model("anthropic.claude-3-opus-20240229-v1:0"),
    ];
    const result = await harness({ models }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "blocked  bedrock deep (opus): newest: anthropic.claude-opus-4-5-20251101-v1:0 is model access not granted",
    );
    expect(result.stderr).toContain("A configured tier can't run here");
  });

  it("bedrock: resolves a pinned inference profile or variant to its model, and skips ARNs", async () => {
    const config = {
      ...baseConfig,
      providers: [
        {
          id: "bedrock",
          harness: "claude-code",
          auth: "bedrock",
          models: {
            // A cross-region profile of a context-window variant: checked as its base model.
            fast: "us.anthropic.claude-3-5-haiku-20241022-v1:0:200k",
            standard: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/x",
            deep: "anthropic.claude-opus-9-v1:0",
          },
        },
      ],
    };
    const result = await harness({ config, models: allTiers }).go(["bedrock", "--id", "bedrock"]);
    expect(result.exitCode).toBe(1);
    const text = result.stderr;
    expect(text).toMatch(/ok {7}bedrock fast .*: anthropic\.claude-3-5-haiku-20241022-v1:0/);
    expect(text).toContain("unknown  bedrock standard");
    expect(text).toContain("anthropic.claude-opus-9-v1:0 isn't offered here");
  });

  it("bedrock: the caller's own IAM permission is a note, not a failure", async () => {
    const models = allTiers.map((m) => ({ ...m, callerAuthorized: false }));
    const result = await harness({ models }).go(["bedrock"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Your own AWS identity isn't allowed");
  });

  it("bedrock: fails when no model is usable, and suggests adding a provider", async () => {
    const config = { ...baseConfig, providers: [baseConfig.providers[0]] };
    const result = await harness({
      config,
      models: [model("anthropic.a", false)],
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

  it("says when the value is stored but the tags couldn't be updated", async () => {
    const h = harness({
      answers: ["SECRET-CURSOR"],
      put: { outcome: "updated", tagError: "not allowed to tag" },
    });
    const result = await h.go(["cursor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Replaced the service-account credential");
    expect(result.stdout).toContain("tags couldn't be updated (not allowed to tag)");
  });

  it("remove: gives the real date, and says when an earlier remove already scheduled it", async () => {
    const date = new Date("2026-11-20T08:30:00Z");
    const fresh = await harness({ remove: { status: "scheduled", deletionDate: date } }).go([
      "remove",
      "old",
      "-y",
    ]);
    expect(fresh.stdout).toContain(
      "Scheduled lgtmoose/provider/old for deletion on 2026-11-20 08:30 UTC",
    );
    const again = await harness({
      remove: { status: "already-scheduled", deletionDate: date },
    }).go(["remove", "old", "-y"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already scheduled for deletion by an earlier remove");
    expect(again.stdout).toContain("2026-11-20 08:30 UTC");
    expect(again.stdout).not.toContain("7 days");
  });

  it("remove: --yes skips the question; a missing secret fails; no means nothing deleted", async () => {
    const yes = harness();
    expect((await yes.go(["remove", "old", "--yes"])).exitCode).toBe(0);
    expect(yes.confirms).toEqual([]);
    const missing = await harness({ remove: { status: "missing" } }).go(["remove", "old", "-y"]);
    expect(missing.stderr).toContain("doesn't exist");
    const no = harness({ confirm: false });
    expect((await no.go(["remove", "old"])).stderr).toContain("Nothing deleted");
    expect(no.removed).toEqual([]);
  });
});
