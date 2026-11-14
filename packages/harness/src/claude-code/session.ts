import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isolatedEnv, networkEnv } from "../env.js";
import type { ClaudeAuthEnv } from "./auth.js";
import { guardScript, sessionSettings } from "./policy.js";

type Source = Readonly<Record<string, string | undefined>>;

/** What a run of Claude Code (the CLI or the Agent SDK, which runs the CLI) starts with. */
export interface ClaudeSession {
  /** The CLI's whole environment: nothing else from this process reaches it. */
  env: Record<string, string>;
  /** The `--settings` layer: permission rules and the Bash guard hook (see `sessionSettings`). */
  settings: Record<string, unknown>;
}

/** Quotes a path for the shell that runs hook commands. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Sets up a run's private home (`home`, already created): the Bash guard script, the CLI's
 * config and temp dirs, and an inline Google key written with mode 0600. Everything is removed
 * with the home after the run.
 */
export async function prepareClaudeSession(
  home: string,
  source: Source,
  auth: ClaudeAuthEnv,
  options: { scrubSubprocessEnv?: boolean } = {},
): Promise<ClaudeSession> {
  const guardPath = join(home, "guard.cjs");
  await writeFile(guardPath, guardScript());
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, "tmp"));
  const env: Record<string, string> = {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...networkEnv(source),
    ...auth.env,
    ...hardeningEnv(home, options.scrubSubprocessEnv ?? false),
  };
  if (auth.googleCredentials !== undefined) {
    const keyPath = join(home, "google-credentials.json");
    // A new file in the run's fresh home: the umask can only narrow 0600. `wx` refuses to
    // write through anything already there.
    await writeFile(keyPath, auth.googleCredentials, { mode: 0o600, flag: "wx" });
    env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
  }
  return {
    env,
    settings: sessionSettings(`${shellQuote(process.execPath)} ${shellQuote(guardPath)}`),
  };
}

/**
 * Variables that keep the CLI and git from reading anything but the checkout: a fresh home and
 * config directory, no CLAUDE.md or memory, no updates or telemetry, and git without user or
 * system config, pager, prompts or lazy fetches.
 */
export function hardeningEnv(home: string, scrub: boolean): Record<string, string> {
  return {
    ...isolatedEnv(home),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: scrub ? "1" : "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  };
}
