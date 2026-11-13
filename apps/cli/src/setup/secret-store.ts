import { createHash } from "node:crypto";
import { SECRET_NAMES } from "@lgtmoose/config";
import { z } from "zod";

/** The only Secrets Manager calls setup makes. Tests swap in an in-memory version. */
export interface SetupSecretStore {
  /** The secret's current value, or undefined when it doesn't exist. */
  read(name: string): Promise<string | undefined>;
  /** Creates the secret if it's missing, otherwise stores a new version. */
  write(name: string, value: string, description: string): Promise<"created" | "updated">;
}

/** The JSON stored in `lgtmoose/github-app`. The one description of it; the rest derive from it. */
const appSecretSchema = z.object({
  appId: z.number().int().positive(),
  slug: z.string().min(1),
  privateKey: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /**
   * SHA-256 of the webhook secret stored alongside this App, so a re-run can tell when
   * `lgtmoose/github-webhook-secret` belongs to a different App. Not secret on its own: the
   * webhook secret is 32 random bytes.
   */
  webhookSecretSha256: z.string().optional(),
  /**
   * Set by setup when it created the App's webhook active. Apps made by earlier versions have
   * it off, and GitHub's API can't switch it on, so deploy tells their owners to.
   */
  webhookCreatedActive: z.literal(true).optional(),
});

export type GitHubAppSecret = z.infer<typeof appSecretSchema>;

/** Just enough of an existing App secret to tell the person which App it is. */
const existingSchema = appSecretSchema
  .pick({ appId: true, slug: true, webhookSecretSha256: true })
  .partial();

export interface ExistingApp {
  appId: number | undefined;
  slug: string | undefined;
  webhookSecretSha256?: string | undefined;
}

export function webhookFingerprint(webhookSecret: string): string {
  return createHash("sha256").update(webhookSecret, "utf8").digest("hex");
}

/** Reads the App secret without keeping its private key around. */
export async function readExistingApp(store: SetupSecretStore): Promise<ExistingApp | undefined> {
  const raw = await store.read(SECRET_NAMES.githubApp);
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { appId: undefined, slug: undefined };
  }
  const parsed = existingSchema.safeParse(json);
  if (!parsed.success) return { appId: undefined, slug: undefined };
  return {
    appId: parsed.data.appId,
    slug: parsed.data.slug,
    webhookSecretSha256: parsed.data.webhookSecretSha256,
  };
}

const credentialsSchema = appSecretSchema.pick({
  appId: true,
  slug: true,
  privateKey: true,
  webhookSecretSha256: true,
  webhookCreatedActive: true,
});

/** What `deploy` needs to act as the App: its ID, slug and private key. */
export type AppCredentials = z.infer<typeof credentialsSchema>;

/** The App's credentials, or an error saying to run setup. Never puts the key in a message. */
export async function readAppCredentials(store: SetupSecretStore): Promise<AppCredentials> {
  const raw = await store.read(SECRET_NAMES.githubApp);
  if (raw === undefined) {
    throw new Error(`${SECRET_NAMES.githubApp} doesn't exist. Run pnpm lgtmoose setup first.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = credentialsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${SECRET_NAMES.githubApp} isn't the JSON setup writes (appId, slug, privateKey). ` +
        "Fix it, or run pnpm lgtmoose setup and create a new App.",
    );
  }
  return parsed.data;
}

/**
 * The stored webhook secret if it belongs to `existing`, otherwise why it can't be used.
 * Apps stored before the fingerprint existed only get the "missing" check.
 */
export async function readWebhookSecret(
  store: SetupSecretStore,
  existing: ExistingApp,
): Promise<{ secret: string; problem?: undefined } | { secret?: undefined; problem: string }> {
  const webhook = await store.read(SECRET_NAMES.githubWebhook);
  if (webhook === undefined) {
    return {
      problem: `${SECRET_NAMES.githubWebhook} is missing, so the gateway can't verify webhooks.`,
    };
  }
  if (
    existing.webhookSecretSha256 !== undefined &&
    existing.webhookSecretSha256 !== webhookFingerprint(webhook)
  ) {
    return {
      problem: `${SECRET_NAMES.githubWebhook} doesn't belong to this App, so the gateway would reject its webhooks.`,
    };
  }
  return { secret: webhook };
}

export interface StoredSecrets {
  app: "created" | "updated";
  webhook: "created" | "updated";
}

/**
 * Writes the webhook secret, then the App secret, which records the webhook secret's
 * fingerprint. If the App write fails, the previous webhook secret is put back, so the old
 * App keeps working and a re-run sees a consistent pair. Should that also fail, the
 * fingerprint lets the next run spot the mismatch instead of keeping it.
 */
export async function storeAppSecrets(
  store: SetupSecretStore,
  app: GitHubAppSecret,
  webhookSecret: string,
): Promise<StoredSecrets> {
  const previousWebhook = await store.read(SECRET_NAMES.githubWebhook);
  const webhookDescription = (slug: string) =>
    `Webhook secret for GitHub App ${slug}. Read by the lgtmoose gateway.`;
  const webhook = await store.write(
    SECRET_NAMES.githubWebhook,
    webhookSecret,
    webhookDescription(app.slug),
  );
  const record: GitHubAppSecret = {
    ...app,
    webhookSecretSha256: webhookFingerprint(webhookSecret),
  };
  try {
    const stored = await store.write(
      SECRET_NAMES.githubApp,
      JSON.stringify(record),
      `Credentials for GitHub App ${app.slug} (id ${app.appId}). Written by lgtmoose setup.`,
    );
    return { app: stored, webhook };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // First install: no App secret exists, so a re-run starts over and nothing needs undoing.
    if (previousWebhook === undefined) {
      throw new Error(`Couldn't store ${SECRET_NAMES.githubApp}: ${reason}`, { cause: error });
    }
    try {
      await store.write(SECRET_NAMES.githubWebhook, previousWebhook, "Restored by lgtmoose setup.");
    } catch {
      throw new Error(
        `Couldn't store ${SECRET_NAMES.githubApp} (${reason}), and couldn't restore the previous ` +
          `${SECRET_NAMES.githubWebhook}. The two secrets now belong to different Apps: run ` +
          "setup again and create a new App.",
        { cause: error },
      );
    }
    throw new Error(
      `Couldn't store ${SECRET_NAMES.githubApp}: ${reason}. Restored the previous ` +
        `${SECRET_NAMES.githubWebhook}, so the existing App still works. The new App ` +
        `"${app.slug}" exists on GitHub; delete it, then run setup again.`,
      { cause: error },
    );
  }
}
