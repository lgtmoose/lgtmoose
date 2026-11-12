import { generateKeyPairSync } from "node:crypto";
import { CDK_CONTEXT, SECRET_NAMES, STACK_NAMES } from "@lgtmoose/config";
import { describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_WEBHOOK_URL } from "../setup/manifest.js";
import type { Prompter } from "../setup/prompter.js";
import { webhookFingerprint, type SetupSecretStore } from "../setup/secret-store.js";
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
    stacks?: Record<string, string>;
    outputs?: StackOutputs;
    previousWebhookUrl?: string;
    prompter?: Partial<Prompter>;
    failWebhook?: boolean;
  } = {},
) {
  const secrets = new Map(Object.entries(options.secrets ?? goodSecrets));
  const store: SetupSecretStore = {
    read: (name) => Promise.resolve(secrets.get(name)),
    write: () => Promise.reject(new Error("deploy never writes secrets")),
  };
  const calls: string[] = [];
  const deployed: DeployOptions[] = [];
  const destroyed: (Readonly<Record<string, string>> | undefined)[] = [];
  const cdk: Cdk = {
    bootstrap: () => {
      calls.push("bootstrap");
      return Promise.resolve();
    },
    deploy: (deployOptions) => {
      calls.push("deploy");
      deployed.push(deployOptions);
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
      return Promise.resolve();
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
    getWebhookUrl: () => Promise.resolve(options.previousWebhookUrl),
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
  const stackStatus: Record<string, string> = {
    CDKToolkit: "UPDATE_COMPLETE",
    [STACK_NAMES.data]: "CREATE_COMPLETE",
    ...options.stacks,
  };
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
    stacks: () => ({ status: (name) => Promise.resolve(stackStatus[name] || undefined) }),
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
  return { deps, calls, deployed, destroyed, webhooks, regions, output: () => chunks.join("") };
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
    expect(h.calls).toEqual(["deploy", "webhook"]);
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

  it("bootstraps the CDK the first time only", async () => {
    const first = harness({ stacks: { CDKToolkit: "" } });
    await run(runDeploy, [], first);
    expect(first.calls).toEqual(["bootstrap", "deploy", "webhook"]);
    const failed = harness({ stacks: { CDKToolkit: "ROLLBACK_COMPLETE" } });
    await run(runDeploy, [], failed);
    expect(failed.calls[0]).toBe("bootstrap");
  });

  it("skips the approval prompt with --yes", async () => {
    const h = harness();
    await run(runDeploy, ["--yes"], h);
    expect(h.deployed[0]?.askToApprove).toBe(false);
  });

  it("points out the Active switch for an App still on the placeholder URL", async () => {
    const h = harness({ previousWebhookUrl: PLACEHOLDER_WEBHOOK_URL });
    const result = await run(runDeploy, [], h);
    expect(result.all).toContain(
      "https://github.com/organizations/acme/settings/apps/lgtmoose-acme",
    );
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
  it("turns off deletion protection, deletes the stacks and says what it kept", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const h = harness({ prompter: { confirm } });
    const result = await run(runDestroy, [], h);
    expect(result.stderr).toBe("");
    expect(confirm).toHaveBeenCalledOnce();
    expect(h.calls).toEqual(["deploy", "destroy", "webhook"]);
    const context = { [CDK_CONTEXT.allowDatabaseDeletion]: "true" };
    expect(h.deployed).toEqual([
      { stacks: [STACK_NAMES.data], exclusively: true, askToApprove: false, context },
    ]);
    expect(h.destroyed).toEqual([context]);
    expect(h.webhooks[0]?.url).toBe(PLACEHOLDER_WEBHOOK_URL);
    expect(result.all).toContain("final snapshot of database lgtmoose-db-1");
    expect(result.all).toContain("artifact bucket: lgtmoose-artifacts-1");
    expect(result.all).toContain("arn:aws:secretsmanager:eu-west-2:1:secret:db");
  });

  it("deletes the data too with --purge", async () => {
    const h = harness();
    const result = await run(runDestroy, ["--purge", "--yes"], h);
    expect(result.exitCode).toBe(0);
    const context = { [CDK_CONTEXT.allowDatabaseDeletion]: "true", [CDK_CONTEXT.purge]: "true" };
    expect(h.deployed[0]?.context).toEqual(context);
    expect(h.destroyed).toEqual([context]);
    expect(result.all).not.toContain("Kept:");
  });

  it("deletes nothing unless the person confirms", async () => {
    const h = harness({ prompter: { confirm: () => Promise.resolve(false) } });
    const result = await run(runDestroy, [], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("Nothing was deleted");
    expect(h.calls).toEqual([]);
  });

  it("never creates the Data stack just to delete it", async () => {
    const h = harness({ stacks: { [STACK_NAMES.data]: "" } });
    await run(runDestroy, ["--yes"], h);
    expect(h.calls).toEqual(["destroy", "webhook"]);
  });

  it("still succeeds when the webhook can't be reset", async () => {
    const h = harness({ failWebhook: true });
    const result = await run(runDestroy, ["--yes"], h);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain("Couldn't reset the App's webhook URL (GitHub is down)");
  });
});
