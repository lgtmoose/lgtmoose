import { generateKeyPairSync } from "node:crypto";
import { CDK_CONTEXT, SECRET_NAMES, STACK_NAMES } from "@lgtmoose/config";
import { describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_WEBHOOK_URL } from "../setup/manifest.js";
import type { Prompter } from "../setup/prompter.js";
import {
  SecretScheduledForDeletion,
  webhookFingerprint,
  type SetupSecretStore,
} from "../setup/secret-store.js";
import type { Cdk, DeployOptions, StackOutputs } from "./cdk.js";
import { runDeploy, runDestroy, type DeployDeps } from "./deploy.js";
import type { GitHubAppApi, WebhookConfig } from "./github-app.js";

const CONFIG_PATH = "/repo/lgtmoose.config.ts";
const WEBHOOK_URL = "https://abc.execute-api.eu-west-2.amazonaws.com/webhooks/github";
const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

const goodSecrets = {
  [SECRET_NAMES.githubApp]: JSON.stringify({
    appId: 42,
    slug: "lgtmoose-acme",
    privateKey: PRIVATE_KEY,
    clientId: "Iv1.x",
    clientSecret: "CLIENT-SECRET",
    webhookSecretSha256: webhookFingerprint("WEBHOOK-SECRET"),
    webhookCreatedActive: true,
  }),
  [SECRET_NAMES.githubWebhook]: "WEBHOOK-SECRET",
};

const bedrockConfig = {
  region: "eu-west-2",
  allowedOrgs: ["acme"],
  providers: [{ id: "claude", harness: "claude-code", auth: "bedrock" }],
};

function harness(
  options: {
    config?: unknown;
    secrets?: Record<string, string>;
    /** Secrets that read as scheduled for deletion. */
    scheduled?: string[];
    /** Data stack status; "" for no stack. */
    dataStatus?: string;
    /** The Data stack has no outputs, as after a create that couldn't roll back. */
    noDataOutputs?: boolean;
    outputs?: StackOutputs;
    prompter?: Partial<Prompter>;
    failWebhook?: boolean;
    /** What RDS says about the database: "done" (it exists) or "missing". */
    database?: "done" | "missing";
    failDestroy?: boolean;
    failDataDeploy?: boolean;
    failProtect?: boolean;
    failUnprotect?: boolean;
  } = {},
) {
  const secrets = new Map(Object.entries(options.secrets ?? goodSecrets));
  const written: string[] = [];
  const store: SetupSecretStore = {
    read: (name) =>
      options.scheduled?.includes(name)
        ? Promise.reject(new SecretScheduledForDeletion(name, "eu-west-2"))
        : Promise.resolve(secrets.get(name)),
    // Deploy writes only the dashboard's copy of the OAuth client.
    write: (name, value) => {
      if (name !== SECRET_NAMES.githubAppOAuth) {
        return Promise.reject(new Error(`deploy never writes ${name}`));
      }
      const existed = secrets.has(name);
      secrets.set(name, value);
      written.push(name);
      return Promise.resolve(existed ? "updated" : "created");
    },
  };
  const calls: string[] = [];
  const deployed: DeployOptions[] = [];
  const destroyed: (Readonly<Record<string, string>> | undefined)[] = [];
  const cdk: Cdk = {
    bootstrap: (account) => {
      calls.push(`bootstrap:${account}`);
      return Promise.resolve();
    },
    deploy: (deployOptions) => {
      calls.push("deploy");
      deployed.push(deployOptions);
      if (options.failDataDeploy && deployOptions.stacks !== "all") {
        return Promise.reject(new Error("Data stack update failed"));
      }
      return Promise.resolve(
        options.outputs ?? {
          [STACK_NAMES.api]: { GithubWebhookUrl: WEBHOOK_URL },
          [STACK_NAMES.data]: {
            DatabaseIdentifier: "lgtmoose-db-1",
            DatabaseSecretArn: "arn:aws:secretsmanager:eu-west-2:1:secret:db",
            ArtifactBucketName: "lgtmoose-artifacts-1",
          },
        },
      );
    },
    destroyAll: (context) => {
      calls.push("destroy");
      destroyed.push(context);
      return options.failDestroy
        ? Promise.reject(new Error("cdk destroy failed"))
        : Promise.resolve();
    },
  };
  const webhooks: WebhookConfig[] = [];
  const github: GitHubAppApi = {
    getApp: () =>
      Promise.resolve({
        id: 42,
        slug: "lgtmoose-acme",
        owner: { login: "acme", type: "Organization" },
      }),
    setWebhook: (_jwt, config) => {
      if (options.failWebhook) return Promise.reject(new Error("GitHub is down"));
      calls.push("webhook");
      webhooks.push(config);
      return Promise.resolve();
    },
  };
  const unexpected = (message: string) =>
    Promise.reject(new Error(`unexpected prompt: ${message}`));
  const chunks: string[] = [];
  const regions: string[] = [];
  const dataOutputs = {
    DatabaseIdentifier: "lgtmoose-db-1",
    DatabaseSecretArn: "arn:aws:secretsmanager:eu-west-2:1:secret:db",
    ArtifactBucketName: "lgtmoose-artifacts-1",
  };
  const dataStatus = options.dataStatus ?? "UPDATE_COMPLETE";
  const protection: string[] = [];
  const deps: DeployDeps = {
    configPath: CONFIG_PATH,
    files: {
      exists: () => Promise.resolve(options.config !== null),
      loadConfig: () => Promise.resolve(options.config ?? bedrockConfig),
    },
    secrets: (region) => {
      regions.push(region);
      return store;
    },
    stacks: () => ({
      describe: (name) =>
        Promise.resolve(
          name === STACK_NAMES.data && dataStatus !== ""
            ? { status: dataStatus, outputs: options.noDataOutputs ? {} : dataOutputs }
            : undefined,
        ),
      physicalIds: (name, type) =>
        Promise.resolve(
          name === STACK_NAMES.data && type === "AWS::RDS::DBInstance" ? ["lgtmoose-db-1"] : [],
        ),
    }),
    database: () => ({
      setDeletionProtection: (id, enabled) => {
        calls.push(enabled ? "protect" : "unprotect");
        protection.push(`${id}:${enabled}`);
        if (enabled && options.failProtect) return Promise.reject(new Error("AccessDenied"));
        if (!enabled && options.failUnprotect) {
          return Promise.reject(new Error("still modifying after 30 minutes"));
        }
        return Promise.resolve(options.database ?? "done");
      },
    }),
    account: () => Promise.resolve("123456789012"),
    cdk: () => cdk,
    github,
    prompter: {
      input: (o) => unexpected(o.message),
      select: (o) => unexpected(o.message),
      confirm: (o) => unexpected(o.message),
      ...options.prompter,
    },
    out: (text) => chunks.push(text),
    now: () => new Date("2026-11-12T12:00:00Z"),
  };
  return {
    deps,
    calls,
    deployed,
    destroyed,
    webhooks,
    regions,
    protection,
    secrets,
    written,
    output: () => chunks.join(""),
  };
}

async function run(command: typeof runDeploy, argv: string[], h: ReturnType<typeof harness>) {
  const result = await command(argv, () => Promise.resolve(h.deps));
  return { ...result, all: h.output() + result.stdout + result.stderr };
}

describe("lgtmoose deploy", () => {
  it("deploys every stack, then points the webhook at the gateway with the stored secret", async () => {
    const h = harness();
    const result = await run(runDeploy, [], h);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // Bootstrap names the environment, so the CDK doesn't synthesize the app twice; the
    // database's protection is put back in case an interrupted destroy left it off.
    expect(h.calls).toEqual(["bootstrap:123456789012", "deploy", "webhook", "protect"]);
    expect(h.protection).toEqual(["lgtmoose-db-1:true"]);
    expect(h.deployed).toEqual([{ stacks: "all", askToApprove: true }]);
    expect(h.regions).toEqual(["eu-west-2"]);
    expect(h.webhooks).toEqual([
      { url: WEBHOOK_URL, secret: "WEBHOOK-SECRET", contentType: "json" },
    ]);
    expect(result.all).toContain("https://github.com/apps/lgtmoose-acme/installations/new");
    expect(result.all).toContain("git pull && pnpm lgtmoose deploy");
    for (const secret of ["WEBHOOK-SECRET", "CLIENT-SECRET", "PRIVATE KEY"]) {
      expect(result.all).not.toContain(secret);
    }
  });

  it("copies the App's OAuth client for the dashboard, once, and prints where to sign in", async () => {
    const h = harness({
      outputs: {
        [STACK_NAMES.api]: { GithubWebhookUrl: WEBHOOK_URL },
        [STACK_NAMES.dashboard]: {
          DashboardUrl: "https://d1.cloudfront.net",
          OAuthCallbackUrl: "https://d1.cloudfront.net/api/auth/callback",
        },
      },
    });
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(0);
    expect(h.written).toEqual([SECRET_NAMES.githubAppOAuth]);
    expect(JSON.parse(h.secrets.get(SECRET_NAMES.githubAppOAuth) ?? "")).toEqual({
      clientId: "Iv1.x",
      clientSecret: "CLIENT-SECRET",
    });
    expect(result.all).toContain("The dashboard is at https://d1.cloudfront.net");
    expect(result.all).toContain("https://d1.cloudfront.net/api/auth/callback");
    expect(result.all).not.toContain("CLIENT-SECRET");
    // A second deploy finds it current and writes nothing.
    const again = harness({ secrets: Object.fromEntries(h.secrets) });
    await run(runDeploy, [], again);
    expect(again.written).toEqual([]);
  });

  it("writes no OAuth copy with dashboard: false", async () => {
    const h = harness({ config: { ...bedrockConfig, dashboard: false } });
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(0);
    expect(h.written).toEqual([]);
    expect(result.all).not.toContain("dashboard is at");
  });

  it("prints the release check's notice before deploying, and still deploys", async () => {
    const h = harness();
    h.deps.releaseCheck = () =>
      Promise.resolve("Warning: this checkout is LGTMoose 0.1.0, and v0.2.0 is out.\n");
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("v0.2.0 is out");
    expect(result.all.indexOf("v0.2.0 is out")).toBeLessThan(result.all.indexOf("Bootstrapping"));
    expect(h.calls).toEqual(["bootstrap:123456789012", "deploy", "webhook", "protect"]);
  });

  it("only warns when it can't check deletion protection, since everything is live", async () => {
    const h = harness({ failProtect: true });
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("Warning: couldn't check deletion protection on lgtmoose-db-1");
    expect(result.all).toContain("installations/new");
  });

  it("tells owners of Apps from an earlier setup to switch the webhook on", async () => {
    const old = JSON.parse(goodSecrets[SECRET_NAMES.githubApp] ?? "") as Record<string, unknown>;
    delete old.webhookCreatedActive;
    const h = harness({
      secrets: { ...goodSecrets, [SECRET_NAMES.githubApp]: JSON.stringify(old) },
    });
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('Tick "Active"');
    expect(result.all).toContain(
      "https://github.com/organizations/acme/settings/apps/lgtmoose-acme",
    );
    expect((await run(runDeploy, [], harness())).all).not.toContain('Tick "Active"');
  });

  it("skips the approval prompt with --yes", async () => {
    const h = harness();
    await run(runDeploy, ["--yes"], h);
    expect(h.deployed[0]?.askToApprove).toBe(false);
  });

  it("stops before CloudFormation when setup hasn't run", async () => {
    const noConfig = harness({ config: null });
    const result = await run(runDeploy, [], noConfig);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Run pnpm lgtmoose setup first");
    expect(noConfig.calls).toEqual([]);

    const noApp = harness({ secrets: {} });
    expect((await run(runDeploy, [], noApp)).stderr).toContain(
      `${SECRET_NAMES.githubApp} doesn't exist`,
    );
    expect(noApp.calls).toEqual([]);
  });

  it("refuses a webhook secret that doesn't belong to the App", async () => {
    const h = harness({ secrets: { ...goodSecrets, [SECRET_NAMES.githubWebhook]: "OTHER" } });
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("doesn't belong to this App");
    expect(h.calls).toEqual([]);
  });

  it("says to run auth again for a provider credential scheduled for deletion", async () => {
    const config = {
      ...bedrockConfig,
      providers: [{ id: "codex", harness: "codex", auth: "chatgpt-login" }],
    };
    const h = harness({ config, scheduled: [SECRET_NAMES.provider("codex")] });
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is scheduled for deletion in eu-west-2");
    expect(result.stderr).toContain("pnpm lgtmoose auth for it again");
    expect(h.calls).toEqual([]);
  });

  it("needs a stored credential for every provider that isn't Bedrock", async () => {
    const config = {
      ...bedrockConfig,
      providers: [{ id: "codex", harness: "codex", auth: "chatgpt-login" }],
    };
    const missing = harness({ config });
    const result = await run(runDeploy, [], missing);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${SECRET_NAMES.provider("codex")}, which doesn't exist`);

    const present = harness({
      config,
      secrets: { ...goodSecrets, [SECRET_NAMES.provider("codex")]: "token" },
    });
    expect((await run(runDeploy, [], present)).exitCode).toBe(0);
  });

  it("reports an invalid config by key", async () => {
    const h = harness({ config: { ...bedrockConfig, profile: "huge" } });
    const result = await run(runDeploy, [], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("profile");
  });

  it("rejects unknown flags with help", async () => {
    const result = await run(runDeploy, ["--purge"], harness());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: lgtmoose deploy");
  });
});

describe("lgtmoose destroy", () => {
  it("turns off deletion protection through RDS, deletes the stacks and says what it kept", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const h = harness({ prompter: { confirm } });
    const result = await run(runDestroy, [], h);
    expect(result.stderr).toBe("");
    expect(confirm).toHaveBeenCalledOnce();
    expect(h.calls).toEqual(["unprotect", "destroy", "webhook"]);
    expect(h.protection).toEqual(["lgtmoose-db-1:false"]);
    expect(h.deployed).toEqual([]);
    expect(h.destroyed).toEqual([{ [CDK_CONTEXT.allowDatabaseDeletion]: "true" }]);
    expect(h.webhooks).toEqual([{ url: PLACEHOLDER_WEBHOOK_URL }]);
    expect(result.all).toContain("final snapshot of database lgtmoose-db-1");
    expect(result.all).toContain("artifact bucket: lgtmoose-artifacts-1");
    expect(result.all).toContain("arn:aws:secretsmanager:eu-west-2:1:secret:db");
  });

  it("turns protection back on when the stacks can't be deleted", async () => {
    const h = harness({ failDestroy: true });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(h.calls).toEqual(["unprotect", "destroy", "protect"]);
  });

  it("turns protection back on when the --purge stack update fails", async () => {
    const h = harness({ failDataDeploy: true });
    const result = await run(runDestroy, ["--purge", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(h.calls).toEqual(["unprotect", "deploy", "protect"]);
    expect(result.stderr).toContain("Turned the database's deletion protection back on");
  });

  it("switches the Data stack back to keeping its data when destroy --purge fails later", async () => {
    const h = harness({ failDestroy: true });
    const result = await run(runDestroy, ["--purge", "--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(h.calls).toEqual(["unprotect", "deploy", "destroy", "deploy", "protect"]);
    expect(h.deployed[1]).toEqual({
      stacks: [STACK_NAMES.data],
      exclusively: true,
      askToApprove: false,
    });
    expect(result.stderr).toContain("Switched the Data stack back to keeping its data");
  });

  it("restores protection when turning it off fails partway", async () => {
    const h = harness({ failUnprotect: true });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(h.calls).toEqual(["unprotect", "protect"]);
    expect(result.stderr).toContain("Turned the database's deletion protection back on");
  });

  it("doesn't claim protection is back on for a database that's gone", async () => {
    const h = harness({ failDestroy: true, database: "missing" });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.stderr).toContain("Database lgtmoose-db-1 is already gone or being deleted");
    expect(result.stderr).not.toContain("back on");
  });

  it("says so when protection can't be turned back on", async () => {
    const h = harness({ failDestroy: true, failProtect: true });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cdk destroy failed");
    expect(result.stderr).toContain(
      "Deletion protection is still off on lgtmoose-db-1 (AccessDenied)",
    );
  });

  it("doesn't claim a snapshot of a database that was already gone", async () => {
    const h = harness({ dataStatus: "DELETE_FAILED", database: "missing" });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).not.toContain("final snapshot of database");
    expect(result.all).toContain("artifact bucket: lgtmoose-artifacts-1");
  });

  it("says the App's webhook now points at the placeholder", async () => {
    const result = await run(runDestroy, ["--yes"], harness());
    expect(result.all).toContain("webhook now points at a placeholder");
    expect(result.all).not.toContain("untouched");
  });

  it("recovers from an earlier destroy that left the Data stack in DELETE_FAILED", async () => {
    const h = harness({ dataStatus: "DELETE_FAILED" });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(h.calls).toEqual(["unprotect", "destroy", "webhook"]);
  });

  it("finds the database from the stack's resources after a create that couldn't roll back", async () => {
    const h = harness({ dataStatus: "ROLLBACK_FAILED", noDataOutputs: true });
    const result = await run(runDestroy, ["--purge", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(h.calls).toEqual(["unprotect", "destroy", "webhook"]);
    expect(h.protection).toEqual(["lgtmoose-db-1:false"]);
  });

  it("switches the Data stack to delete its data with --purge", async () => {
    const h = harness();
    const result = await run(runDestroy, ["--purge", "--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(h.calls).toEqual(["unprotect", "deploy", "destroy", "webhook"]);
    const context = { [CDK_CONTEXT.allowDatabaseDeletion]: "true", [CDK_CONTEXT.purge]: "true" };
    expect(h.deployed).toEqual([
      { stacks: [STACK_NAMES.data], exclusively: true, askToApprove: false, context },
    ]);
    expect(h.destroyed).toEqual([context]);
    expect(result.all).toContain("redeployed from this checkout");
    expect(result.all).toContain("expire on their own");
    expect(result.all).not.toContain("Kept:");
  });

  it("says what --purge couldn't delete when the Data stack can't be updated", async () => {
    const h = harness({ dataStatus: "DELETE_FAILED" });
    const result = await run(runDestroy, ["--purge", "--yes"], h);
    expect(h.calls).toEqual(["unprotect", "destroy", "webhook"]);
    expect(result.all).toContain("couldn't be switched to delete its data");
    expect(result.all).toContain("Kept:");
  });

  it("deletes nothing unless the person confirms", async () => {
    const h = harness({ prompter: { confirm: () => Promise.resolve(false) } });
    const result = await run(runDestroy, [], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("Nothing was deleted");
    expect(h.calls).toEqual([]);
  });

  it("never creates the Data stack just to delete it", async () => {
    const h = harness({ dataStatus: "" });
    await run(runDestroy, ["--purge", "--yes"], h);
    expect(h.calls).toEqual(["destroy", "webhook"]);
  });

  it("still succeeds when the webhook can't be reset", async () => {
    const h = harness({ failWebhook: true });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("Couldn't reset the App's webhook URL (GitHub is down)");
  });
});
