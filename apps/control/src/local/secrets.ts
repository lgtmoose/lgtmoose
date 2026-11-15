import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialSecrets } from "../credentials.js";

/**
 * Secrets for the docker compose deployment (NIC-843): one file per secret in a directory the
 * runner alone mounts, in place of Secrets Manager. A secret's file is its Secrets Manager name
 * with `/` written as `__` (Docker secrets can't hold a `/`): `lgtmoose/github-app` is
 * `lgtmoose__github-app`. Values are never logged.
 */

/** The file a secret name is kept in, inside `dir`. */
export function secretFile(dir: string, name: string): string {
  const file = name.replaceAll("/", "__");
  if (!/^[A-Za-z0-9._-]+$/.test(file) || file.startsWith(".")) {
    throw new Error(`Not a secret name: ${name}`);
  }
  return join(dir, file);
}

/** Reads a secret's value, or undefined when there's no file. */
export async function readSecretFile(dir: string, name: string): Promise<string | undefined> {
  try {
    return (await readFile(secretFile(dir, name), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function version(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * The credential broker's view of the secrets directory (`CredentialSecrets`). A secret's
 * version is a hash of its value, so the broker's "unchanged since the lease was taken" check
 * holds as with Secrets Manager. A write replaces the file atomically (write, then rename), so a
 * sandbox starting meanwhile reads the old value or the new one, never half of either.
 */
export function fileCredentialSecrets(dir: string): CredentialSecrets {
  return {
    async describe(secretId) {
      const file = secretFile(dir, secretId);
      try {
        const [value, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
        return {
          exists: true,
          deleting: false,
          currentVersion: version(value.trim()),
          currentSince: info.mtime,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return {
          exists: false,
          deleting: false,
          currentVersion: undefined,
          currentSince: undefined,
        };
      }
    },
    async read(secretId) {
      const value = await readSecretFile(dir, secretId);
      if (value === undefined) throw new Error(`No secret ${secretId} in the secrets directory.`);
      return value;
    },
    async write(secretId, value) {
      const file = secretFile(dir, secretId);
      const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, file);
      return version(value.trim());
    },
  };
}
