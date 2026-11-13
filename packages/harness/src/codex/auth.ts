import { HarnessError } from "../harness.js";

/** How Codex reaches the model. Matches `HARNESS_AUTH.codex` in @lgtmoose/config. */
export type CodexAuthMethod = "chatgpt-login" | "access-token" | "api-key";

export interface CodexAuth {
  method: CodexAuthMethod;
  /** Variables the CLI needs for this method. Empty for a ChatGPT sign-in. */
  env: Record<string, string>;
  /** For a ChatGPT sign-in: the `auth.json` to write into the run's `CODEX_HOME`. */
  authJson?: string;
  /** Values to keep out of transcripts, errors and output. */
  secrets: string[];
}

type Source = Readonly<Record<string, string | undefined>>;

/** Keys in `auth.json` whose values are credentials: tokens and API keys. */
const SECRET_KEY = /token|key/i;

/**
 * The credential values in an `auth.json`, at any depth: every string under a key that names a
 * token or key (`access_token`, `refresh_token`, `id_token`, `OPENAI_API_KEY`). Invalid JSON
 * gives none; the CLI will report it.
 */
export function authJsonSecrets(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const found: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (SECRET_KEY.test(key)) found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
    } else if (value !== null && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) walk(item, name);
    }
  };
  walk(parsed, "");
  return found;
}

/**
 * Picks the Codex credential from the environment, and passes on only that one:
 * - `CODEX_AUTH_JSON`: the contents of a ChatGPT sign-in's `auth.json` (from the credential
 *   broker), written into a fresh `CODEX_HOME` for the run;
 * - `CODEX_ACCESS_TOKEN`: a Codex access token;
 * - `CODEX_API_KEY` or `OPENAI_API_KEY`: an API key, passed as `CODEX_API_KEY`.
 */
export function codexAuth(source: Source): CodexAuth {
  const authJson = source.CODEX_AUTH_JSON;
  if (authJson !== undefined && authJson.trim() !== "") {
    try {
      JSON.parse(authJson);
    } catch {
      throw new HarnessError("auth", "CODEX_AUTH_JSON is set but isn't valid JSON.");
    }
    return { method: "chatgpt-login", env: {}, authJson, secrets: authJsonSecrets(authJson) };
  }
  if (source.CODEX_ACCESS_TOKEN) {
    return {
      method: "access-token",
      env: { CODEX_ACCESS_TOKEN: source.CODEX_ACCESS_TOKEN },
      secrets: [source.CODEX_ACCESS_TOKEN],
    };
  }
  const key = source.CODEX_API_KEY || source.OPENAI_API_KEY;
  if (key) return { method: "api-key", env: { CODEX_API_KEY: key }, secrets: [key] };
  throw new HarnessError(
    "auth",
    "No Codex credential found. Set CODEX_AUTH_JSON (a ChatGPT sign-in's auth.json), CODEX_ACCESS_TOKEN, or CODEX_API_KEY / OPENAI_API_KEY.",
  );
}
