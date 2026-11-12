import { SECRET_NAMES } from "@lgtmoose/config";
import { z } from "zod";

/** The only Secrets Manager calls setup makes. Tests swap in an in-memory version. */
export interface SecretStore {
  /** The secret's current value, or undefined when it doesn't exist. */
  read(name: string): Promise<string | undefined>;
  /** Creates the secret if it's missing, otherwise stores a new version. */
  write(name: string, value: string, description: string): Promise<"created" | "updated">;
}

/** The JSON stored in `lgtmoose/github-app`. */
export interface GitHubAppSecret {
  appId: number;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

/** Just enough of an existing App secret to tell the person which App it is. */
export interface ExistingApp {
  appId: number | undefined;
  slug: string | undefined;
}

const existingSchema = z.object({
  appId: z.number().optional(),
  slug: z.string().optional(),
});

/** Reads the App secret without keeping its private key around. */
export async function readExistingApp(store: SecretStore): Promise<ExistingApp | undefined> {
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
  return { appId: parsed.data.appId, slug: parsed.data.slug };
}

export interface StoredSecrets {
  app: "created" | "updated";
  webhook: "created" | "updated";
}

/**
 * Writes the webhook secret first and the App secret last. Setup treats the App secret as
 * "done", so if the second write fails a re-run starts over instead of keeping half a setup.
 */
export async function storeAppSecrets(
  store: SecretStore,
  app: GitHubAppSecret,
  webhookSecret: string,
): Promise<StoredSecrets> {
  const webhook = await store.write(
    SECRET_NAMES.githubWebhook,
    webhookSecret,
    `Webhook secret for GitHub App ${app.slug}. Read by the lgtmoose gateway.`,
  );
  const stored = await store.write(
    SECRET_NAMES.githubApp,
    JSON.stringify(app),
    `Credentials for GitHub App ${app.slug} (id ${app.appId}). Written by lgtmoose setup.`,
  );
  return { app: stored, webhook };
}
