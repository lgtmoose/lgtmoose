import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { SECRET_NAMES } from "@lgtmoose/config";
import { describe, expect, it, vi } from "vitest";
import { awsSecretStore, type SecretsManagerSender } from "./aws-secret-store.js";
import { readExistingApp, storeAppSecrets, type SecretStore } from "./secret-store.js";

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
    expect(JSON.parse(stored)).toEqual(app);
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
    const store: SecretStore = {
      read: () => Promise.resolve(undefined),
      write: (name) => {
        order.push(name);
        return Promise.resolve("created");
      },
    };
    await storeAppSecrets(store, app, "whsec");
    expect(order).toEqual([SECRET_NAMES.githubWebhook, SECRET_NAMES.githubApp]);
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
