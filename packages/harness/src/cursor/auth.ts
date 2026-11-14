import { HarnessError } from "../harness.js";

/**
 * How the Cursor CLI reaches the model. A user's API key and a service account's key are both
 * sent as `CURSOR_API_KEY`. Matches `HARNESS_AUTH["cursor-agent"]` in @lgtmoose/config.
 */
export type CursorAuthMethod = "api-key" | "service-account";

export interface CursorAuth {
  /** Variables the CLI needs. */
  env: Record<string, string>;
  /** Values to keep out of transcripts, errors and output. */
  secrets: string[];
}

/** Picks the Cursor API key from the environment and passes on only that. */
export function cursorAuth(source: Readonly<Record<string, string | undefined>>): CursorAuth {
  const key = source.CURSOR_API_KEY?.trim();
  if (!key) {
    throw new HarnessError(
      "auth",
      "No Cursor credential found. Set CURSOR_API_KEY (a user or service-account API key).",
    );
  }
  return { env: { CURSOR_API_KEY: key }, secrets: [key] };
}
