import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { DASHBOARD_REPORT_VIEW } from "@lgtmoose/db";
import { readSecretFile, secretFile } from "./secrets.js";

/** The compose dashboard's settings (NIC-1056), apart from its entrypoint so they're tested. */

/** The signing key's file in the dashboard's secrets directory, generated on first start. */
export const SIGNING_KEY_SECRET = "lgtmoose/dashboard-signing-key";

/** An https origin with no path: what the browser sends as `Origin`. */
export function parseOrigin(value: string): string {
  const origin = value.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(origin)) {
    throw new Error(
      "DASHBOARD_ORIGIN must be an https origin, such as https://lgtmoose.example.com.",
    );
  }
  return origin.toLowerCase();
}

/**
 * The signing key: read from the secrets directory, or generated and stored there once. The file
 * is created exclusively, so two starts at once keep one key between them.
 */
export async function signingKey(dir: string): Promise<Buffer> {
  const file = secretFile(dir, SIGNING_KEY_SECRET);
  let value = await readSecretFile(dir, SIGNING_KEY_SECRET);
  if (value === undefined) {
    try {
      await writeFile(file, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    value = (await readFile(file, "utf8")).trim();
  }
  if (value.length < 32) throw new Error("The dashboard signing key is too short.");
  return Buffer.from(value, "utf8");
}

/**
 * The feedback report, read through the view of that one artifact the dashboard's login may
 * read (`DASHBOARD_REPORT_VIEW`), not the `artifacts` table. Undefined until the reconciler has
 * written one.
 */
export function viewFeedbackReport(pool: {
  query(text: string): Promise<{ rows: { body: Buffer }[] }>;
}): () => Promise<unknown> {
  return async () => {
    const result = await pool.query(`select body from ${DASHBOARD_REPORT_VIEW}`);
    const row = result.rows[0];
    return row === undefined ? undefined : (JSON.parse(row.body.toString("utf8")) as unknown);
  };
}
