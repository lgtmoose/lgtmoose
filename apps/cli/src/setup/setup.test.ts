import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SECRET_NAMES, parseDeployConfig } from "@lgtmoose/config";
import { describe, expect, it, vi } from "vitest";
import { CALLBACK_PATH } from "./callback-server.js";
import type { CreatedApp } from "./github.js";
import type { Prompter } from "./prompter.js";
import {
  SecretScheduledForDeletion,
  webhookFingerprint,
  type SetupSecretStore,
} from "./secret-store.js";
import { runSetup, type SetupDeps } from "./setup.js";

const CONFIG_PATH = "/repo/lgtmoose.config.ts";

const created: CreatedApp = {
  id: 42,
  slug: "lgtmoose-acme",
  name: "lgtmoose-acme",
  htmlUrl: "https://github.com/apps/lgtmoose-acme",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nFAKE-PRIVATE-KEY\n-----END RSA PRIVATE KEY-----\n",
  webhookSecret: "FAKE-WEBHOOK-SECRET",
  clientId: "Iv1.FAKECLIENTID",
  clientSecret: "FAKE-CLIENT-SECRET",
};
const SECRET_VALUES = [
  created.pem,
  "FAKE-PRIVATE-KEY",
  "FAKE-WEBHOOK-SECRET",
  "FAKE-CLIENT-SECRET",
];

function memoryStore(initial: Record<string, string> = {}, scheduled: string[] = []) {
  const secrets = new Map(Object.entries(initial));
  const reads: string[] = [];
  const store: SetupSecretStore = {
    read: (name) =>
      reads.push(name) && scheduled.includes(name)
        ? Promise.reject(new SecretScheduledForDeletion(name, "eu-west-1"))
        : Promise.resolve(secrets.get(name)),
    write: (name, value) => {
      const existed = secrets.has(name);
      secrets.set(name, value);
      return Promise.resolve(existed ? "updated" : "created");
    },
  };
  return { secrets, store, reads };
}

/** Plays the person's browser and GitHub: load our page, then follow the redirect back. */
async function actAsGitHub(pageUrl: string, tamperState = false): Promise<void> {
  const html = await (await fetch(pageUrl)).text();
  const action = /action="([^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&") ?? "";
  const state = new URL(action).searchParams.get("state") ?? "";
  if (tamperState) {
    const forged = await fetch(new URL(`${CALLBACK_PATH}?code=evil&state=forged`, pageUrl));
    expect(forged.status).toBe(400);
  }
  await fetch(new URL(`${CALLBACK_PATH}?code=temp-code&state=${state}`, pageUrl));
}

interface Harness {
  deps: SetupDeps;
  output: () => string;
  secrets: Map<string, string>;
  files: Map<string, string>;
  convertManifest: ReturnType<typeof vi.fn<(code: string) => Promise<CreatedApp>>>;
  openBrowser: ReturnType<typeof vi.fn<(url: string) => Promise<boolean>>>;
  regions: string[];
  reads: string[];
}

function harness(
  options: {
    secrets?: Record<string, string>;
    /** Secrets that read as scheduled for deletion. */
    scheduled?: string[];
    files?: Record<string, string>;
    /** What importing each file returns. Files without an entry fail to import. */
    configs?: Record<string, unknown>;
    prompter?: Partial<Prompter>;
    app?: CreatedApp;
    tamperState?: boolean;
  } = {},
): Harness {
  const { secrets, store, reads } = memoryStore(options.secrets, options.scheduled);
  const files = new Map(Object.entries(options.files ?? {}));
  const chunks: string[] = [];
  const regions: string[] = [];
  const convertManifest = vi.fn((_code: string) => Promise.resolve(options.app ?? created));
  const openBrowser = vi.fn((url: string) => {
    void actAsGitHub(url, options.tamperState);
    return Promise.resolve(true);
  });
  const unexpected = (message: string) =>
    Promise.reject(new Error(`unexpected prompt: ${message}`));
  const prompter: Prompter = {
    input: (o) => unexpected(o.message),
    confirm: (o) => unexpected(o.message),
    select: (o) => unexpected(o.message),
    ...options.prompter,
  };
  return {
    deps: {
      prompter,
      github: { convertManifest },
      secrets: (region) => {
        regions.push(region);
        return store;
      },
      openBrowser,
      files: {
        exists: (path) => Promise.resolve(files.has(path)),
        write: (path, content) => {
          files.set(path, content);
          return Promise.resolve();
        },
        loadConfig: (path) =>
          options.configs !== undefined && path in options.configs
            ? Promise.resolve(options.configs[path])
            : Promise.reject(new SyntaxError("Unexpected token")),
      },
      configPath: CONFIG_PATH,
      out: (text) => chunks.push(text),
      timeoutMs: 5_000,
    },
    output: () => chunks.join(""),
    secrets,
    files,
    convertManifest,
    openBrowser,
    regions,
    reads,
  };
}

async function setup(argv: string[], h: Harness) {
  const result = await runSetup(argv, () => Promise.resolve(h.deps));
  return { ...result, all: h.output() + result.stdout + result.stderr };
}

/**
 * Loads the rendered config the way `cdk synth` does: imports the file, then validates it. It's
 * written inside this package so its `@lgtmoose/config` import resolves.
 */
const SCRATCH = fileURLToPath(new URL("../../node_modules/.cache/setup-test/", import.meta.url));
async function writtenConfig(text: string) {
  mkdirSync(SCRATCH, { recursive: true });
  const path = join(SCRATCH, `config-${randomUUID()}.ts`);
  writeFileSync(path, text);
  try {
    const module = (await import(pathToFileURL(path).href)) as { default: unknown };
    return parseDeployConfig(module.default);
  } finally {
    rmSync(path, { force: true });
  }
}

describe("runSetup: first run", () => {
  it("creates the App, stores both secrets and writes the config", async () => {
    const h = harness();
    const result = await setup(
      ["--org", "acme", "--region", "eu-west-1", "--profile", "standard", "--yes"],
      h,
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(h.convertManifest).toHaveBeenCalledWith("temp-code");
    expect(h.regions).toEqual(["eu-west-1"]);

    expect(JSON.parse(h.secrets.get(SECRET_NAMES.githubApp) ?? "")).toEqual({
      appId: 42,
      slug: "lgtmoose-acme",
      privateKey: created.pem,
      clientId: created.clientId,
      clientSecret: created.clientSecret,
      webhookSecretSha256: webhookFingerprint("FAKE-WEBHOOK-SECRET"),
      webhookCreatedActive: true,
    });
    expect(h.secrets.get(SECRET_NAMES.githubWebhook)).toBe("FAKE-WEBHOOK-SECRET");

    const config = await writtenConfig(h.files.get(CONFIG_PATH) ?? "");
    expect(config).toMatchObject({
      region: "eu-west-1",
      profile: "standard",
      allowedOrgs: ["acme"],
      providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
    });
  });

  it("never prints a secret, and prints the install link and next steps", async () => {
    const h = harness();
    const result = await setup(["--org", "acme", "--yes"], h);
    for (const value of SECRET_VALUES) expect(result.all).not.toContain(value);
    expect(result.all).toContain("https://github.com/apps/lgtmoose-acme/installations/new");
    // The handle people type in PR comments, and how to make the docs' @lgtmoose work (NIC-1119).
    expect(result.all).toContain("@lgtmoose-acme review");
    expect(result.all).toContain('commandAliases: ["lgtmoose"]');
    expect(result.all).toContain("pnpm lgtmoose auth");
    expect(result.all).toContain("pnpm lgtmoose deploy");
  });

  it("prints the local URL in case the browser doesn't open", async () => {
    const h = harness();
    h.openBrowser.mockImplementation((url) => {
      void actAsGitHub(url);
      return Promise.resolve(false);
    });
    const result = await setup(["--user", "octocat", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toMatch(/Couldn't open a browser\. Visit http:\/\/127\.0\.0\.1:\d+\//);
  });

  it("ignores a forged callback and finishes with the real one", async () => {
    const h = harness({ tamperState: true });
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(h.convertManifest).toHaveBeenCalledTimes(1);
    expect(h.convertManifest).toHaveBeenCalledWith("temp-code");
  });

  it("generates a webhook secret when GitHub doesn't return one", async () => {
    const h = harness({ app: { ...created, webhookSecret: null } });
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(h.secrets.get(SECRET_NAMES.githubWebhook)).toMatch(/^[0-9a-f]{64}$/);
    expect(result.all).toContain("generated by setup");
    expect(result.all).not.toContain(h.secrets.get(SECRET_NAMES.githubWebhook));
  });

  it.each([SECRET_NAMES.githubApp, SECRET_NAMES.githubWebhook])(
    "stops before creating an App when %s is scheduled for deletion",
    async (name) => {
      const h = harness({ scheduled: [name] });
      const result = await setup(["--org", "acme", "--region", "eu-west-1", "--yes"], h);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`${name} is scheduled for deletion`);
      expect(result.stderr).toContain("restore-secret");
      expect(h.openBrowser).not.toHaveBeenCalled();
      expect(h.convertManifest).not.toHaveBeenCalled();
      expect(h.secrets.size).toBe(0);
    },
  );

  it("stops with a clear message when the exchange fails, storing nothing", async () => {
    const h = harness();
    h.convertManifest.mockRejectedValue(new Error("GitHub couldn't finish creating the App"));
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Setup failed: GitHub couldn't finish creating the App");
    expect(h.secrets.size).toBe(0);
    expect(h.files.size).toBe(0);
  });

  it("times out when GitHub never calls back", async () => {
    const h = harness();
    h.deps.timeoutMs = 20;
    h.openBrowser.mockResolvedValue(true);
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Gave up waiting for GitHub");
  });

  it("reports Ctrl+C at a prompt as a cancel", async () => {
    const cancel = Object.assign(new Error("User force closed the prompt"), {
      name: "ExitPromptError",
    });
    const h = harness({ prompter: { select: () => Promise.reject(cancel) } });
    const result = await setup([], h);
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toBe("Setup cancelled.\n");
  });
});

describe("runSetup: re-run", () => {
  const existing = {
    [SECRET_NAMES.githubApp]: JSON.stringify({
      appId: 7,
      slug: "lgtmoose-old",
      privateKey: "OLD-PRIVATE-KEY",
      clientId: "Iv1.old",
      clientSecret: "OLD-CLIENT-SECRET",
    }),
    [SECRET_NAMES.githubWebhook]: "OLD-WEBHOOK-SECRET",
  };
  const mine = {
    [CONFIG_PATH]: {
      region: "us-east-1",
      allowedOrgs: ["acme"],
      providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
    },
  };

  it("keeps an existing App with --yes and skips the manifest flow", async () => {
    const h = harness({ secrets: existing });
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('"lgtmoose-old" (App ID 7)');
    expect(result.all).toContain("Keeping the existing App");
    expect(h.openBrowser).not.toHaveBeenCalled();
    expect(h.secrets).toEqual(new Map(Object.entries(existing)));
    expect(result.all).toContain("https://github.com/apps/lgtmoose-old/installations/new");
    expect(result.all).not.toContain("OLD-PRIVATE-KEY");
  });

  it("keeps it when the person chooses to", async () => {
    const select = vi.fn(() => Promise.resolve("keep" as never));
    const h = harness({ secrets: existing, prompter: { select } });
    const result = await setup(
      ["--org", "acme", "--app-name", "x", "--region", "us-east-1", "--profile", "lean"],
      h,
    );
    expect(result.exitCode).toBe(0);
    expect(select).toHaveBeenCalledOnce();
    expect(h.openBrowser).not.toHaveBeenCalled();
  });

  it("creates a new App and replaces both secrets when asked", async () => {
    const h = harness({
      secrets: existing,
      prompter: { select: () => Promise.resolve("create" as never) },
    });
    const result = await setup(
      [
        "--org",
        "acme",
        "--app-name",
        "lgtmoose-acme",
        "--region",
        "us-east-1",
        "--profile",
        "lean",
      ],
      h,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(h.secrets.get(SECRET_NAMES.githubApp) ?? "")).toMatchObject({ appId: 42 });
    expect(h.secrets.get(SECRET_NAMES.githubWebhook)).toBe("FAKE-WEBHOOK-SECRET");
    expect(result.all).toContain("(updated)");
    expect(result.all).toContain('The old App "lgtmoose-old" still exists');
    // Read once, before the App was created, and reused for the restore-on-failure value.
    expect(h.reads.filter((name) => name === SECRET_NAMES.githubWebhook)).toHaveLength(1);
  });

  it("won't keep an App whose webhook secret is missing", async () => {
    const h = harness({
      secrets: { [SECRET_NAMES.githubApp]: existing[SECRET_NAMES.githubApp] ?? "" },
    });
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${SECRET_NAMES.githubWebhook} is missing`);
    expect(h.openBrowser).not.toHaveBeenCalled();
  });

  it("offers only a new App when the webhook secret belongs to another one", async () => {
    const select = vi.fn();
    const confirm = vi.fn(() => Promise.resolve(true));
    const h = harness({
      secrets: {
        [SECRET_NAMES.githubApp]: JSON.stringify({
          ...JSON.parse(existing[SECRET_NAMES.githubApp] ?? ""),
          webhookSecretSha256: webhookFingerprint("SOME-OTHER-SECRET"),
        }),
        [SECRET_NAMES.githubWebhook]: "OLD-WEBHOOK-SECRET",
      },
      prompter: { select, confirm },
    });
    const result = await setup(
      [
        "--org",
        "acme",
        "--app-name",
        "lgtmoose-acme",
        "--region",
        "us-east-1",
        "--profile",
        "lean",
      ],
      h,
    );
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("doesn't belong to this App");
    expect(select).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
    expect(JSON.parse(h.secrets.get(SECRET_NAMES.githubApp) ?? "")).toMatchObject({ appId: 42 });
  });

  it("won't silently replace an App secret it can't read", async () => {
    const h = harness({ secrets: { [SECRET_NAMES.githubApp]: "hand-made" } });
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Left lgtmoose/github-app untouched");
    expect(h.secrets.get(SECRET_NAMES.githubApp)).toBe("hand-made");
  });

  it("keeps an existing config with --yes", async () => {
    const h = harness({ secrets: existing, files: { [CONFIG_PATH]: "// mine" }, configs: mine });
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(h.files.get(CONFIG_PATH)).toBe("// mine");
    expect(result.all).toContain(`Kept the existing ${CONFIG_PATH}`);
  });

  it("keeps an existing config unless the person confirms", async () => {
    const select = () => Promise.resolve("keep" as never);
    const flags = [
      "--org",
      "acme",
      "--app-name",
      "x",
      "--region",
      "us-east-1",
      "--profile",
      "lean",
    ];

    const declined = harness({
      secrets: existing,
      files: { [CONFIG_PATH]: "// mine" },
      configs: mine,
      prompter: { select, confirm: () => Promise.resolve(false) },
    });
    await setup(flags, declined);
    expect(declined.files.get(CONFIG_PATH)).toBe("// mine");

    const confirmed = harness({
      secrets: existing,
      files: { [CONFIG_PATH]: "// mine" },
      configs: mine,
      prompter: { select, confirm: () => Promise.resolve(true) },
    });
    await setup(flags, confirmed);
    expect(confirmed.files.get(CONFIG_PATH)).toContain("defineConfig");
  });
});

describe("runSetup: an existing config that points elsewhere", () => {
  const config = (region: string, allowedOrgs = ["acme"]) => ({
    files: { [CONFIG_PATH]: "// mine" },
    configs: {
      [CONFIG_PATH]: {
        region,
        allowedOrgs,
        providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
      },
    },
  });

  it("uses the config's region by default, so a re-run finds the App it made", async () => {
    const h = harness(config("eu-west-2"));
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(h.regions).toEqual(["eu-west-2"]);
    expect(h.files.get(CONFIG_PATH)).toBe("// mine");
  });

  it("stops with --yes before touching secrets when the region differs", async () => {
    const h = harness(config("eu-west-2"));
    const result = await setup(["--org", "acme", "--region", "us-east-1", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("it deploys to eu-west-2, but this run uses us-east-1");
    expect(h.regions).toEqual([]);
    expect(h.openBrowser).not.toHaveBeenCalled();
  });

  it("stops when the owner isn't in allowedOrgs, unless the person replaces the config", async () => {
    const flags = [
      "--org",
      "globex",
      "--app-name",
      "x",
      "--region",
      "us-east-1",
      "--profile",
      "lean",
    ];
    const declined = harness({
      ...config("us-east-1"),
      prompter: { confirm: () => Promise.resolve(false) },
    });
    const refused = await setup(flags, declined);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("allowedOrgs doesn't include globex");
    expect(declined.regions).toEqual([]);

    const confirm = vi.fn(() => Promise.resolve(true));
    const accepted = harness({ ...config("us-east-1"), prompter: { confirm } });
    const result = await setup(flags, accepted);
    expect(result.exitCode).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect((await writtenConfig(accepted.files.get(CONFIG_PATH) ?? "")).allowedOrgs).toEqual([
      "globex",
    ]);
  });

  it("won't keep a config it can't load with --yes", async () => {
    const h = harness({ files: { [CONFIG_PATH]: "// broken" } });
    const result = await setup(["--org", "acme", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("couldn't be loaded");
  });
});

describe("runSetup: flags", () => {
  it("shows help without building any dependency", async () => {
    const getDeps = vi.fn();
    const result = await runSetup(["--help"], getDeps);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("--org <name>");
    expect(getDeps).not.toHaveBeenCalled();
  });

  it("reports a bad flag with the setup help", async () => {
    const getDeps = vi.fn();
    const result = await runSetup(["--region", "moon"], getDeps);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--region "moon"');
    expect(result.stderr).toContain("Usage: lgtmoose setup");
    expect(getDeps).not.toHaveBeenCalled();
  });
});
