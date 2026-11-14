import { HARNESS_AUTH, isPlanCredential, type AuthMethod, type Harness } from "@lgtmoose/config";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI } from "../paths.js";
import {
  AUTH_HELP,
  PLAN_CREDENTIAL_HEADER,
  planCredentialWarning,
  runAuth,
  type AuthDeps,
} from "./auth.js";
import type { InferenceProfile, ModelAccess } from "./bedrock.js";
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
    profiles?: InferenceProfile[];
    /** The identity may not list inference profiles. */
    noProfileList?: boolean;
    profilesFail?: boolean;
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
  const legacyAsked: string[][] = [];
  const bedrockCalls: string[] = [];
  const reruns: (string | undefined)[] = [];
  const store: CredentialStore = {
    put: (label, value, putOptions) => {
      puts.push({ label, value });
      reruns.push(putOptions?.rerun);
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
    bedrock: () => ({
      anthropicModels: (asked) => {
        bedrockCalls.push("models");
        legacyAsked.push([...(asked?.legacyToCheck ?? [])]);
        return Promise.resolve(options.models ?? []);
      },
      inferenceProfiles: () => {
        bedrockCalls.push("profiles");
        if (options.profilesFail === true) return Promise.reject(new Error("throttled"));
        return Promise.resolve(
          options.noProfileList === true ? undefined : (options.profiles ?? []),
        );
      },
    }),
    run,
    trapSignals: () => () => {},
    tmpRoot,
    out: (text) => out.push(text),
  };
  const go = async (argv: string[]) => {
    const result = await runAuth(argv, () => Promise.resolve(deps));
    return { ...result, all: [...out, result.stdout, result.stderr].join("") };
  };
  return { go, puts, removed, out, run, validated, confirms, legacyAsked, reruns, bedrockCalls };
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
    expect((await runAuth(["remove"], getDeps)).stderr).toContain(
      "needs the provider id: pnpm lgtmoose auth remove <id>.",
    );
    expect((await runAuth(["remove", "../x"], getDeps)).stderr).toContain("isn't a provider id");
    expect((await runAuth(["cursor", "--id", "A"], getDeps)).stderr).toContain(
      "isn't a provider id",
    );
    const vendor = await runAuth(["api-key", "--provider", "google"], getDeps);
    expect(vendor.stderr).toContain("--provider anthropic or --provider openai");
    expect(getDeps).not.toHaveBeenCalled();
  });

  it("tailors the plan-credential warning to the credential and points at docs/providers.md", () => {
    const claude = planCredentialWarning({ harness: "claude-code", auth: "oauth-token" });
    expect(claude).toContain(PLAN_CREDENTIAL_HEADER);
    expect(claude).toContain("auth api-key --provider anthropic");
    expect(claude).toContain("commercial terms");
    const login = planCredentialWarning({ harness: "codex", auth: "chatgpt-login" });
    expect(login).toContain("auth codex --access-token");
    // Storing an access token doesn't recommend an access token.
    const token = planCredentialWarning({ harness: "codex", auth: "access-token" });
    expect(token).toContain("acts as the workspace user who created it");
    expect(token).not.toContain("auth codex --access-token");
    const cursor = planCredentialWarning({ harness: "cursor-agent", auth: "api-key" });
    expect(cursor).toContain('"service-account"');
    for (const text of [claude, login, token, cursor]) {
      expect(text).toContain("docs/providers.md");
      // Each says to redeploy after changing the provider's auth.
      expect(text).toContain(`${CLI} deploy`);
    }
    expect(claude).not.toContain("Codex");
    expect(claude).toContain("Ultra plans fall under Anthropic's consumer terms");
    // The suggested commands say which config change they need first.
    expect(claude).toContain('auth to "api-key"');
    expect(login).toContain('auth "access-token"');
    expect(token).toContain("dedicated bot user");
    // Each names a way out that needs no plan credential, by command or auth value.
    expect(claude).toContain('Bedrock (auth "bedrock"');
    expect(token).toContain("auth api-key --provider openai");
    expect(cursor).toContain("auth api-key --provider anthropic");
  });

  it("gives advice for every plan credential isPlanCredential recognises", () => {
    for (const [harness, auths] of Object.entries(HARNESS_AUTH) as [
      Harness,
      readonly AuthMethod[],
    ][]) {
      for (const auth of auths) {
        if (!isPlanCredential({ harness, auth })) continue;
        // Throws when a plan credential has no advice of its own.
        expect(() => planCredentialWarning({ harness, auth }), `${harness}/${auth}`).not.toThrow();
      }
    }
  });

  it("claude: warns, confirms, runs setup-token, then stores the pasted token", async () => {
    const h = harness({ answers: [ANTHROPIC_KEY, "not a token", `  ${OAUTH}\n`] });
    const result = await h.go(["claude"]);
    expect(result.exitCode).toBe(0);
    expect(h.out.join("")).toContain(PLAN_CREDENTIAL_HEADER);
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
    expect(h.out.join("")).toContain(PLAN_CREDENTIAL_HEADER);
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
    expect(h.out.join("")).toContain(PLAN_CREDENTIAL_HEADER);
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

  it("tells the store the exact command, so its messages can say to run it again", async () => {
    const h = harness({ answers: [ANTHROPIC_KEY] });
    await h.go(["api-key", "--provider", "anthropic", "--id", "anthropic"]);
    expect(h.reruns).toEqual(["pnpm lgtmoose auth api-key --provider anthropic --id anthropic"]);
  });

  it("cursor: a user API key bills to a personal plan, so it gets the warning", async () => {
    const config = {
      ...baseConfig,
      providers: [{ id: "cursor", harness: "cursor-agent", auth: "api-key" }],
    };
    const declined = harness({ config, confirm: false, answers: ["SECRET-CURSOR"] });
    expect((await declined.go(["cursor"])).stderr).toContain("Nothing stored");
    expect(declined.out.join("")).toContain(PLAN_CREDENTIAL_HEADER);
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

  const model = (
    modelId: string,
    options: Partial<Omit<ModelAccess, "modelId">> = {},
  ): ModelAccess => {
    const usable = options.usable ?? true;
    return {
      modelId,
      name: modelId,
      usable,
      problems: usable ? [] : [{ text: "model access not granted", fix: "access" as const }],
      inferenceTypes: ["ON_DEMAND", "INFERENCE_PROFILE"],
      legacy: false,
      callerAuthorized: true,
      ...options,
    };
  };
  const HAIKU = "anthropic.claude-3-5-haiku-20241022-v1:0";
  const SONNET = "anthropic.claude-sonnet-4-5-20250929-v1:0";
  const OPUS = "anthropic.claude-opus-4-6-v1";
  const pinned = (models: Record<string, string>) => ({
    ...baseConfig,
    region: "eu-west-2",
    providers: [{ id: "bedrock", harness: "claude-code", auth: "bedrock", models }],
  });

  const profile = (id: string) => ({ id, modelId: id.replace(/^[a-z-]+\./, "") });

  it("bedrock: aliases are hints, not checks, and the list shows the ids to pin", async () => {
    const h = harness({
      models: [
        model(HAIKU),
        model(SONNET, { inferenceTypes: ["INFERENCE_PROFILE"] }),
        model(OPUS),
        model("anthropic.claude-instant-v1", { usable: false }),
      ],
      profiles: [profile(`eu.${SONNET}`), profile(`global.${SONNET}`)],
    });
    const result = await h.go(["bedrock"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "  blocked  anthropic.claude-instant-v1: model access not granted",
    );
    // Real profile ids from Bedrock, for a model with no on-demand calls.
    expect(result.stdout).toContain(`  ok       eu.${SONNET} or global.${SONNET}`);
    expect(result.stdout).toContain(
      `not checked  bedrock standard (sonnet): Claude Code picks the sonnet model at runtime. ` +
        `Pin a model id in models.standard to have it checked (usable sonnet ids here: eu.${SONNET}, global.${SONNET})`,
    );
    expect(result.stdout).toContain("needs no stored secret");
    expect(h.puts).toEqual([]);
  });

  it("bedrock: fails an alias whose family has no usable model at all", async () => {
    const result = await harness({
      models: [model(HAIKU), model(SONNET), model(OPUS, { usable: false })],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "blocked      bedrock deep (opus): no usable opus model in eu-west-2",
    );
  });

  it("bedrock: a family whose model has no way to be called here counts as none", async () => {
    const result = await harness({
      models: [model(HAIKU), model(SONNET), model(OPUS, { inferenceTypes: ["INFERENCE_PROFILE"] })],
      profiles: [],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`  blocked  ${OPUS}: no way to call it here`);
    expect(result.stderr).toContain("no usable opus model");
  });

  it("bedrock: handles Claude Code modifiers, opusplan and default", async () => {
    const config = pinned({ fast: "haiku[1m]", standard: "default", deep: "opusplan" });
    const ok = await harness({ config, models: [model(HAIKU), model(SONNET), model(OPUS)] }).go([
      "bedrock",
    ]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("not checked  bedrock standard (default)");
    expect(ok.stdout).toContain("(opusplan): Claude Code picks the opus and sonnet model");
    // opusplan also needs Sonnet.
    const noSonnet = await harness({ config, models: [model(HAIKU), model(OPUS)] }).go(["bedrock"]);
    expect(noSonnet.stderr).toContain("(opusplan): no usable sonnet model");
  });

  it("bedrock: an Anthropic API id isn't a Bedrock id, so it's blocked", async () => {
    const config = pinned({ fast: HAIKU, standard: "claude-sonnet-4-5-20250929", deep: OPUS });
    const result = await harness({
      config,
      models: [model(HAIKU), model(SONNET), model(OPUS)],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("(claude-sonnet-4-5-20250929): not a Bedrock model id");
  });

  it("bedrock: a bare id must be callable on demand; a profile id must be one Bedrock lists", async () => {
    const config = pinned({
      fast: `eu.${HAIKU}`,
      standard: SONNET,
      deep: `us.${OPUS}`,
    });
    const models = [
      model(HAIKU),
      model(SONNET, { inferenceTypes: ["INFERENCE_PROFILE"] }),
      model(OPUS, { inferenceTypes: ["INFERENCE_PROFILE"] }),
    ];
    const profiles = [profile(`eu.${HAIKU}`), profile(`eu.${SONNET}`), profile(`global.${OPUS}`)];
    const result = await harness({ config, models, profiles }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ok {11}bedrock fast .*: eu\.anthropic\.claude-3-5-haiku/);
    expect(result.stderr).toContain(
      `${SONNET}: can only be called through an inference profile; use eu.${SONNET}`,
    );
    expect(result.stderr).toContain(
      `us.${OPUS}: isn't an inference profile eu-west-2 can call; use global.${OPUS}`,
    );
    // Both are pinned the wrong way, not missing access: only the pinning advice.
    expect(result.stderr).toContain("  - Fix the id in bedrock.models.standard.");
    expect(result.stderr).toContain("  - Fix the id in bedrock.models.deep.");
    expect(result.stderr).not.toContain("Request model access");
  });

  it("bedrock: without bedrock:ListInferenceProfiles, profile ids aren't checked but on-demand ids are", async () => {
    const config = pinned({
      fast: `eu.${HAIKU}`,
      standard: SONNET,
      deep: "anthropic.claude-nope-v1:0",
    });
    const result = await harness({
      config,
      models: [model(HAIKU), model(SONNET), model(OPUS, { inferenceTypes: ["INFERENCE_PROFILE"] })],
      noProfileList: true,
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `not checked  bedrock fast (eu.${HAIKU}): eu.${HAIKU}: needs bedrock:ListInferenceProfiles`,
    );
    expect(result.stderr).toMatch(/ok {11}bedrock standard/);
    expect(result.stderr).toContain("anthropic.claude-nope-v1:0: isn't offered");
    expect(result.stderr).toContain(
      `  unknown  ${OPUS}: callable only through an inference profile`,
    );
    expect(result.stderr).toContain("so profile ids weren't checked. On-demand ids were.");
  });

  it("bedrock: lists profiles first, and doesn't start the model checks if that fails", async () => {
    const ok = harness({ models: [model(HAIKU), model(SONNET), model(OPUS)] });
    await ok.go(["bedrock"]);
    expect(ok.bedrockCalls).toEqual(["profiles", "models"]);
    const failing = harness({ profilesFail: true });
    const result = await failing.go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("throttled");
    expect(failing.bedrockCalls).toEqual(["profiles"]);
  });

  const ACCESS_FIX =
    "  - Request model access (and accept its agreement) in the Bedrock console for eu-west-2, then run this again.";
  const REGION_FIX = "  - Pick another region, or a model that has an inference profile here.";
  const fixesOf = (text: string) => {
    const block = text.split("To fix:\n")[1] ?? "";
    return block.split("\n\n")[0]?.split("\n").filter(Boolean) ?? [];
  };

  it("bedrock: a blocked alias tier prints its members' problems, and one fix each", async () => {
    const unreachable = (id: string) => model(id, { inferenceTypes: ["INFERENCE_PROFILE"] });
    // Access granted, but opus can't be called here: the problem says so, and only the
    // region fix follows. No claim about access.
    const noRoute = await harness({
      models: [model(HAIKU), model(SONNET), unreachable(OPUS)],
      profiles: [],
    }).go(["bedrock"]);
    expect(noRoute.exitCode).toBe(1);
    expect(noRoute.stderr).toContain(
      `blocked      bedrock deep (opus): no usable opus model in eu-west-2: ${OPUS} no way to call it here`,
    );
    expect(fixesOf(noRoute.stderr)).toEqual([REGION_FIX]);
    expect(noRoute.stderr).not.toContain("Access is granted");
    // Opus lacks access: Bedrock's own problem, and the access fix.
    const access = await harness({
      models: [model(HAIKU), model(SONNET), model(OPUS, { usable: false })],
    }).go(["bedrock"]);
    expect(access.stderr).toContain(`${OPUS} model access not granted`);
    expect(fixesOf(access.stderr)).toEqual([ACCESS_FIX]);
    // "Not offered in this region" is a region problem, not an access one.
    const notOffered = await harness({
      models: [
        model(HAIKU),
        model(SONNET),
        model(OPUS, {
          usable: false,
          problems: [{ text: "not offered in this region", fix: "region" }],
        }),
      ],
    }).go(["bedrock"]);
    expect(fixesOf(notOffered.stderr)).toEqual([REGION_FIX]);
    // Both problems, each fix once.
    const mixed = await harness({
      models: [model(HAIKU, { usable: false }), model(SONNET), unreachable(OPUS)],
      profiles: [],
    }).go(["bedrock"]);
    expect(fixesOf(mixed.stderr)).toEqual([ACCESS_FIX, REGION_FIX]);
  });

  it("bedrock: no route here is the only fix, ahead of a missing access", async () => {
    // Opus lacks access, but can only be called through a profile and there is none here.
    const result = await harness({
      models: [
        model(HAIKU),
        model(SONNET),
        model(OPUS, { usable: false, inferenceTypes: ["INFERENCE_PROFILE"] }),
      ],
      profiles: [],
    }).go(["bedrock"]);
    expect(result.stderr).toContain(`  blocked  ${OPUS}: no way to call it here`);
    expect(result.stderr).not.toContain("model access not granted");
    expect(fixesOf(result.stderr)).toEqual([REGION_FIX]);
  });

  it("bedrock: a pending agreement says to wait, and the notes come before the fixes", async () => {
    const result = await harness({
      models: [
        model(HAIKU),
        model(SONNET),
        model(OPUS, { usable: false, problems: [{ text: "agreement pending", fix: "wait" }] }),
      ],
    }).go(["bedrock"]);
    expect(fixesOf(result.stderr)).toEqual([
      "  - Wait a few minutes for the model agreement to go through, then run this again.",
    ]);
    const text = result.stderr;
    expect(text.indexOf("needs no stored secret")).toBeLessThan(text.indexOf("To fix:"));
  });

  it("bedrock: missing access with a pending agreement gives both fixes", async () => {
    const result = await harness({
      models: [
        model(HAIKU),
        model(SONNET),
        model(OPUS, {
          usable: false,
          problems: [
            { text: "model access not granted", fix: "access" },
            { text: "agreement pending", fix: "wait" },
          ],
        }),
      ],
    }).go(["bedrock"]);
    expect(result.stderr).toContain(`${OPUS} model access not granted, ${OPUS} agreement pending`);
    expect(fixesOf(result.stderr)).toEqual([
      ACCESS_FIX,
      "  - Wait a few minutes for the model agreement to go through, then run this again.",
    ]);
  });

  it("bedrock: a model Bedrock couldn't check gets the recheck fix, not access", async () => {
    const result = await harness({
      models: [
        model(HAIKU),
        model(SONNET),
        model(OPUS, {
          usable: false,
          problems: [{ text: "couldn't check (bad model id)", fix: "recheck" }],
        }),
      ],
    }).go(["bedrock"]);
    expect(fixesOf(result.stderr)).toEqual([
      "  - Run this again; if a model still can't be checked, pin a different one.",
    ]);
  });

  it("bedrock: with nothing usable, the fixes come from each model's own problems", async () => {
    const config = { ...baseConfig, providers: [baseConfig.providers[0]] };
    const result = await harness({
      config,
      models: [
        model(OPUS, { inferenceTypes: ["INFERENCE_PROFILE"] }),
        model(SONNET, { usable: false }),
      ],
      profiles: [],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("This account can't use any Anthropic model here.");
    expect(fixesOf(result.stderr)).toEqual([REGION_FIX, ACCESS_FIX]);
  });

  it("bedrock: keeps the legacy marker on a profile id it couldn't check", async () => {
    const LEGACY = "anthropic.claude-3-opus-20240229-v1:0";
    const config = pinned({ fast: "arn:aws:x", standard: "arn:aws:y", deep: `eu.${LEGACY}` });
    const result = await harness({
      config,
      models: [model(LEGACY, { legacy: true })],
      noProfileList: true,
    }).go(["bedrock"]);
    expect(result.stdout + result.stderr).toContain(
      `eu.${LEGACY} (legacy: Bedrock is retiring it): needs bedrock:ListInferenceProfiles`,
    );
  });

  it("bedrock: a profile pin of an on-demand-only model is wrong, even when profiles can't be listed", async () => {
    const config = pinned({ fast: `us.${HAIKU}`, standard: SONNET, deep: OPUS });
    const result = await harness({
      config,
      models: [model(HAIKU, { inferenceTypes: ["ON_DEMAND"] }), model(SONNET), model(OPUS)],
      noProfileList: true,
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `fast (us.${HAIKU}): us.${HAIKU}: has no inference profile; use ${HAIKU}`,
    );
    expect(result.stderr).toContain("  - Fix the id in bedrock.models.fast.");
  });

  it("bedrock: a global. id is checked against the list too", async () => {
    const config = pinned({ fast: `global.${HAIKU}`, standard: SONNET, deep: OPUS });
    const result = await harness({
      config,
      models: [model(HAIKU), model(SONNET), model(OPUS)],
      profiles: [],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `global.${HAIKU}: isn't an inference profile eu-west-2 can call; use ${HAIKU}`,
    );
  });

  it("bedrock: a pinned id without access still has its pin checked, in the same run", async () => {
    const config = pinned({ fast: HAIKU, standard: SONNET, deep: OPUS });
    const result = await harness({
      config,
      models: [
        model(HAIKU),
        model(SONNET, { usable: false, inferenceTypes: ["INFERENCE_PROFILE"] }),
        model(OPUS),
      ],
      profiles: [profile(`eu.${SONNET}`)],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `standard (${SONNET}): ${SONNET}: model access not granted, can only be called through an inference profile; use eu.${SONNET}`,
    );
    expect(fixesOf(result.stderr)).toEqual([
      ACCESS_FIX,
      "  - Fix the id in bedrock.models.standard.",
    ]);
  });

  it("bedrock: a pinned usable legacy model passes, and is the only legacy model checked", async () => {
    const LEGACY = "anthropic.claude-3-opus-20240229-v1:0";
    const config = pinned({
      fast: `eu.${HAIKU}:200k`,
      standard: "arn:aws:bedrock:eu-west-2:123456789012:application-inference-profile/x",
      deep: LEGACY,
    });
    const h = harness({
      config,
      models: [model(HAIKU, { usable: false }), model(LEGACY, { legacy: true })],
    });
    const result = await h.go(["bedrock"]);
    // Only pinned ids are asked for among legacy models.
    expect(h.legacyAsked).toEqual([[HAIKU, LEGACY]]);
    // Access and the wrong profile prefix, both in one run.
    expect(result.stderr).toContain(
      `fast (eu.${HAIKU}:200k): eu.${HAIKU}: model access not granted, isn't an inference profile eu-west-2 can call; use ${HAIKU}`,
    );
    expect(fixesOf(result.stderr)).toEqual([ACCESS_FIX, "  - Fix the id in bedrock.models.fast."]);
    const pinnedLegacyOnly = pinned({ deep: LEGACY, fast: "arn:aws:x", standard: "arn:aws:y" });
    // The only current model isn't usable: the pinned tier still decides.
    const legacy = await harness({
      config: pinnedLegacyOnly,
      models: [model(HAIKU, { usable: false }), model(LEGACY, { legacy: true })],
    }).go(["bedrock"]);
    expect(legacy.exitCode).toBe(0);
    expect(legacy.stdout).toContain("(legacy: Bedrock is retiring it)");
    expect(legacy.stdout).toContain("not checked  bedrock standard");
    // No contradicting "can't call any model" note when a tier was checked and passed.
    expect(legacy.stdout).not.toContain("can't call any Anthropic model");
    // Legacy models aren't in the general list.
    expect(legacy.stdout).not.toMatch(/^ {2}ok {7}anthropic\.claude-3-opus/m);
  });

  it("bedrock: fails on a pinned model that isn't usable or isn't offered", async () => {
    const config = pinned({ fast: HAIKU, standard: "anthropic.claude-nope-v1:0" });
    const result = await harness({
      config,
      models: [model(HAIKU, { usable: false })],
    }).go(["bedrock"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${HAIKU}: model access not granted`);
    expect(result.stderr).toContain("anthropic.claude-nope-v1:0: isn't offered in eu-west-2");
  });

  it("bedrock: the caller's own IAM permission is a note, not a failure", async () => {
    const models = [model(HAIKU), model(SONNET), model(OPUS, { callerAuthorized: false })];
    const result = await harness({ models }).go(["bedrock"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Your own AWS identity isn't allowed");
  });

  it("bedrock: with no tier to check, fails when no model is usable", async () => {
    const config = { ...baseConfig, providers: [baseConfig.providers[0]] };
    const result = await harness({
      config,
      models: [model("anthropic.a", { usable: false })],
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
      remove: { status: "already-scheduled", scheduledSince: date },
    }).go(["remove", "old", "-y"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already scheduled for deletion by an earlier remove");
    expect(again.stdout).toContain("2026-11-20 08:30 UTC");
    expect(again.stdout).not.toContain("7 days");
    // DescribeSecret gives when the earlier remove ran, not when the secret goes.
    expect(again.stdout).toContain("by an earlier remove on 2026-11-20 08:30 UTC");
    expect(again.stdout).not.toContain("deletion on");
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
