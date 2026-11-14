import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorText } from "../errors.js";
import { CommandNotFound, type InteractiveRunner, type SignalTrap } from "./process.js";
import { CLI } from "../paths.js";

export interface CodexLoginOptions {
  run: InteractiveRunner;
  trapSignals: SignalTrap;
  /** `codex login --device-auth`, for machines without a browser. */
  deviceAuth: boolean;
  /** Where the temporary CODEX_HOME goes. The OS temp dir by default. */
  tmpRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Removes the directory. Tests make it fail. */
  removeDir?: (path: string) => Promise<void>;
}

export class CodexLoginError extends Error {
  override name = "CodexLoginError";
}

/** Raised when the person interrupts the login with Ctrl+C or a signal. */
export class LoginInterrupted extends Error {
  override name = "LoginInterrupted";
}

/**
 * Makes Codex keep the sign-in in `CODEX_HOME/auth.json` rather than the OS keyring, so it can
 * be read and uploaded. Without it, Codex may use the keyring and write no file.
 */
const CONFIG_TOML = 'cli_auth_credentials_store = "file"\n';

/**
 * Runs `codex login` against a fresh, private CODEX_HOME and returns the `auth.json` it wrote.
 * The directory is removed whatever happens: on success, on failure, and on Ctrl+C or a
 * signal (the first one stops `codex`; a second one removes the directory and exits at once).
 */
export async function codexLogin(options: CodexLoginOptions): Promise<string> {
  const home = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "lgtmoose-codex-auth-"));
  const controller = new AbortController();
  const untrap = options.trapSignals(
    () => controller.abort(),
    () => rmSync(home, { recursive: true, force: true }),
  );
  let outcome: { authJson: string } | { error: unknown };
  try {
    await chmod(home, 0o700);
    await writeFile(join(home, "config.toml"), CONFIG_TOML, { mode: 0o600 });
    const args = ["login", ...(options.deviceAuth ? ["--device-auth"] : [])];
    const code = await options.run("codex", args, {
      env: { ...(options.env ?? process.env), CODEX_HOME: home },
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new LoginInterrupted("codex login was interrupted.");
    if (code !== 0) {
      throw new CodexLoginError(`codex login exited with code ${code ?? "unknown"}.`);
    }
    let authJson: string;
    try {
      authJson = await readFile(join(home, "auth.json"), "utf8");
    } catch {
      throw new CodexLoginError(
        "codex login finished but wrote no auth.json. Update Codex and try again.",
      );
    }
    checkAuthJson(authJson);
    outcome = { authJson };
  } catch (error) {
    outcome = { error };
  }

  // Remove before untrapping, so a Ctrl+C during the removal can't leave the file behind, and
  // untrap even if the removal fails, or Ctrl+C would stop working for the rest of the run.
  let leftover: string | undefined;
  try {
    await (options.removeDir ?? ((path) => rm(path, { recursive: true, force: true })))(home);
  } catch (error) {
    leftover =
      ` Also couldn't delete ${home} (${errorText(error)}); ` +
      "delete it yourself, as it may hold the sign-in.";
  } finally {
    untrap();
  }

  // A Ctrl+C at any point means stop, whatever else went wrong, and nothing gets uploaded.
  // After untrap a later one has its normal effect.
  if (controller.signal.aborted) {
    throw new LoginInterrupted(`codex login was interrupted.${leftover ?? ""}`);
  }
  if ("error" in outcome) {
    const { error } = outcome;
    if (leftover === undefined) throw error;
    // A new error with the note, keeping the type callers check for (CommandNotFound gets its
    // install hint), and the original as the cause.
    const message = `${errorText(error)}.${leftover}`;
    if (error instanceof CommandNotFound) throw new CommandNotFound(message, { cause: error });
    throw new CodexLoginError(message, { cause: error });
  }
  if (leftover !== undefined) throw new CodexLoginError(`Nothing stored.${leftover}`);
  return outcome.authJson;
}

/** Checks the file is a ChatGPT sign-in. Never puts any of its content in a message. */
export function checkAuthJson(text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexLoginError("codex login wrote an auth.json that isn't valid JSON.");
  }
  const tokens =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { tokens?: unknown }).tokens
      : undefined;
  const refresh =
    tokens !== null && typeof tokens === "object"
      ? (tokens as { refresh_token?: unknown }).refresh_token
      : undefined;
  if (typeof refresh !== "string" || refresh === "") {
    throw new CodexLoginError(
      "That auth.json has no ChatGPT sign-in (no refresh token). To use an OpenAI API key, " +
        `run ${CLI} auth api-key --provider openai instead.`,
    );
  }
}
