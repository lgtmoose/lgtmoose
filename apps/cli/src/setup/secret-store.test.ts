import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { SECRET_NAMES } from "@lgtmoose/config";
import { describe, expect, it, vi } from "vitest";
import { awsSecretStore, type SecretsManagerSender } from "./aws-secret-store.js";
import {
  readAppCredentials,
  readExistingApp,
  storeAppSecrets,
  webhookFingerprint,
  readWebhookSecret,
  SecretScheduledForDeletion,
  type SetupSecretStore,
} from "./secret-store.js";

function awsError(name: string): Error {
  const error = new Error(`${name} happened`);
  error.name = name;
  return error;
}

/** A fake Secrets Manager that behaves like the real one for the three calls we make. */
function fakeAws(initial: Record<string, string> = {}) {
  const secrets = new Map(Object.entries(initial));
  const send = vi.fn<SecretsManagerSender["send"]>((command) => {
    if (command instanceof GetSecretValueCommand) {
      const value = secrets.get(command.input.SecretId ?? "");
      if (value === undefined) return Promise.reject(awsError("ResourceNotFoundException"));
      return Promise.resolve({ SecretString: value });
    }
    if (command instanceof CreateSecretCommand) {
      const name = command.input.Name ?? "";
      if (secrets.has(name)) return Promise.reject(awsError("ResourceExistsException"));
      secrets.set(name, command.input.SecretString ?? "");
      return Promise.resolve({});
    }
    const name = command.input.SecretId ?? "";
    if (!secrets.has(name)) return Promise.reject(awsError("ResourceNotFoundException"));
    secrets.set(name, command.input.SecretString ?? "");
    return Promise.resolve({});
  });
  return { secrets, send, store: awsSecretStore({ send }, "us-east-1") };
}

const app = {
  appId: 42,
  slug: "lgtmoose-acme",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
  clientId: "Iv1.fake",
  clientSecret: "client-secret-fake",
};

describe("awsSecretStore", () => {
  it("creates a secret that doesn't exist yet", async () => {
    const aws = fakeAws();
    await expect(aws.store.write("lgtmoose/x", "v1", "test")).resolves.toBe("created");
    expect(aws.send.mock.calls.map(([command]) => command.constructor)).toEqual([
      CreateSecretCommand,
    ]);
    expect(aws.secrets.get("lgtmoose/x")).toBe("v1");
  });

  it("puts a new version when the secret already exists", async () => {
    const aws = fakeAws({ "lgtmoose/x": "v1" });
    await expect(aws.store.write("lgtmoose/x", "v2", "test")).resolves.toBe("updated");
    expect(aws.send.mock.calls.map(([command]) => command.constructor)).toEqual([
      CreateSecretCommand,
      PutSecretValueCommand,
    ]);
    expect(aws.secrets.get("lgtmoose/x")).toBe("v2");
  });

  it("reads a missing secret as undefined", async () => {
    await expect(fakeAws().store.read("lgtmoose/x")).resolves.toBeUndefined();
  });

  it("refuses to read a secret scheduled for deletion as missing", async () => {
    const send = vi.fn<SecretsManagerSender["send"]>(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "You can't perform this operation on the secret because it was marked for deletion.",
          ),
          { name: "InvalidRequestException" },
        ),
      ),
    );
    await expect(awsSecretStore({ send }, "us-east-1").read("lgtmoose/provider/x")).rejects.toThrow(
      SecretScheduledForDeletion,
    );
  });

  it("names the region and secret when AWS fails, without the value", async () => {
    const send = vi.fn<SecretsManagerSender["send"]>(() =>
      Promise.reject(awsError("AccessDeniedException")),
    );
    const error = await awsSecretStore({ send }, "eu-west-1")
      .write("lgtmoose/x", "super-secret-value", "test")
      .then(
        () => new Error("expected a rejection"),
        (caught: unknown) => caught as Error,
      );
    expect(error.message).toContain("eu-west-1");
    expect(error.message).toContain("lgtmoose/x");
    expect(error.message).not.toContain("super-secret-value");
  });
});

describe("storeAppSecrets", () => {
  it("keeps the webhook secret in its own secret, apart from the private key", async () => {
    const aws = fakeAws();
    const result = await storeAppSecrets(aws.store, app, "whsec-fake");
    expect(result).toEqual({ app: "created", webhook: "created" });
    expect(aws.secrets.get(SECRET_NAMES.githubWebhook)).toBe("whsec-fake");
    const stored = aws.secrets.get(SECRET_NAMES.githubApp) ?? "";
    expect(JSON.parse(stored)).toEqual({
      ...app,
      webhookSecretSha256: webhookFingerprint("whsec-fake"),
    });
    expect(stored).not.toContain("whsec-fake");
  });

  it("replaces both values on a re-run", async () => {
    const aws = fakeAws({
      [SECRET_NAMES.githubApp]: JSON.stringify({ ...app, appId: 1 }),
      [SECRET_NAMES.githubWebhook]: "old",
    });
    const result = await storeAppSecrets(aws.store, app, "whsec-new");
    expect(result).toEqual({ app: "updated", webhook: "updated" });
    expect(aws.secrets.get(SECRET_NAMES.githubWebhook)).toBe("whsec-new");
    expect(JSON.parse(aws.secrets.get(SECRET_NAMES.githubApp) ?? "")).toMatchObject({ appId: 42 });
  });

  it("writes the App secret last, so a failed run isn't mistaken for a finished one", async () => {
    const order: string[] = [];
    const store: SetupSecretStore = {
      read: () => Promise.resolve(undefined),
      write: (name) => {
        order.push(name);
        return Promise.resolve("created");
      },
    };
    await storeAppSecrets(store, app, "whsec");
    expect(order).toEqual([SECRET_NAMES.githubWebhook, SECRET_NAMES.githubApp]);
  });

  /** A memory store whose App-secret write fails, and optionally the restore too. */
  function failingStore(initial: Record<string, string>, failRestore = false) {
    const secrets = new Map(Object.entries(initial));
    let webhookWrites = 0;
    const store: SetupSecretStore = {
      read: (name) => Promise.resolve(secrets.get(name)),
      write: (name, value) => {
        if (name === SECRET_NAMES.githubApp)
          return Promise.reject(new Error("ThrottlingException"));
        webhookWrites += 1;
        if (failRestore && webhookWrites > 1) return Promise.reject(new Error("AccessDenied"));
        const existed = secrets.has(name);
        secrets.set(name, value);
        return Promise.resolve(existed ? "updated" : "created");
      },
    };
    return { secrets, store };
  }

  const oldPair = {
    [SECRET_NAMES.githubApp]: JSON.stringify({ ...app, appId: 1, slug: "old" }),
    [SECRET_NAMES.githubWebhook]: "whsec-old",
  };

  it("puts the old webhook secret back when the App secret can't be stored", async () => {
    const { secrets, store } = failingStore(oldPair);
    await expect(storeAppSecrets(store, app, "whsec-new")).rejects.toThrow(
      /Restored the previous lgtmoose\/github-webhook-secret/,
    );
    expect(secrets.get(SECRET_NAMES.githubWebhook)).toBe("whsec-old");
    expect(secrets.get(SECRET_NAMES.githubApp)).toBe(oldPair[SECRET_NAMES.githubApp]);
  });

  it("says the pair is broken when the restore fails too", async () => {
    const { store } = failingStore(oldPair, true);
    await expect(storeAppSecrets(store, app, "whsec-new")).rejects.toThrow(
      /now belong to different Apps/,
    );
  });

  it("has nothing to undo on a first install", async () => {
    const { secrets, store } = failingStore({});
    await expect(storeAppSecrets(store, app, "whsec-new")).rejects.toThrow(
      "Couldn't store lgtmoose/github-app: ThrottlingException",
    );
    expect(secrets.has(SECRET_NAMES.githubApp)).toBe(false);
  });
});

describe("readWebhookSecret", () => {
  const problemOf = async (...args: Parameters<typeof readWebhookSecret>) =>
    (await readWebhookSecret(...args)).problem;

  const existing = { appId: 42, slug: "lgtmoose-acme" };

  it("accepts a webhook secret that matches the App's fingerprint", async () => {
    const aws = fakeAws({ [SECRET_NAMES.githubWebhook]: "whsec" });
    await expect(
      problemOf(aws.store, {
        ...existing,
        webhookSecretSha256: webhookFingerprint("whsec"),
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts any webhook secret for an App stored before fingerprints", async () => {
    const aws = fakeAws({ [SECRET_NAMES.githubWebhook]: "whsec" });
    await expect(problemOf(aws.store, existing)).resolves.toBeUndefined();
  });

  it("flags a missing or mismatched webhook secret", async () => {
    await expect(problemOf(fakeAws().store, existing)).resolves.toContain("is missing");
    const aws = fakeAws({ [SECRET_NAMES.githubWebhook]: "whsec-other" });
    await expect(
      problemOf(aws.store, {
        ...existing,
        webhookSecretSha256: webhookFingerprint("whsec"),
      }),
    ).resolves.toContain("doesn't belong to this App");
  });
});

describe("readExistingApp", () => {
  it("returns the slug and App ID only", async () => {
    const aws = fakeAws({ [SECRET_NAMES.githubApp]: JSON.stringify(app) });
    await expect(readExistingApp(aws.store)).resolves.toEqual({
      appId: 42,
      slug: "lgtmoose-acme",
    });
  });

  it("returns undefined when there's no App yet", async () => {
    await expect(readExistingApp(fakeAws().store)).resolves.toBeUndefined();
  });

  it("flags a secret that isn't the expected JSON", async () => {
    const aws = fakeAws({ [SECRET_NAMES.githubApp]: "not json" });
    await expect(readExistingApp(aws.store)).resolves.toEqual({
      appId: undefined,
      slug: undefined,
    });
  });
});

describe("readAppCredentials", () => {
  it("returns what deploy needs to act as the App", async () => {
    const aws = fakeAws({ [SECRET_NAMES.githubApp]: JSON.stringify(app) });
    await expect(readAppCredentials(aws.store)).resolves.toEqual({
      appId: 42,
      slug: "lgtmoose-acme",
      privateKey: app.privateKey,
    });
  });

  it("says to run setup when the secret is missing or malformed, without echoing it", async () => {
    await expect(readAppCredentials(fakeAws().store)).rejects.toThrow("Run pnpm lgtmoose setup");
    const aws = fakeAws({ [SECRET_NAMES.githubApp]: '{"privateKey":"SECRET-KEY"}' });
    const error = await readAppCredentials(aws.store).then(
      () => new Error("expected a rejection"),
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toContain("isn't the JSON setup writes");
    expect(error.message).not.toContain("SECRET-KEY");
  });
});
