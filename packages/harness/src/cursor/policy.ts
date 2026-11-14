import { isAbsolute, relative, resolve } from "node:path";

/**
 * Paths the model has no reason to read, and some that hold the key or the CLI's state: the
 * CLI's own environment (`/proc/self/environ` holds `CURSOR_API_KEY`), the run's home (`~`) and
 * temp dirs. Any of them that holds the checkout is left out (`cursorPermissions`).
 */
export const OUTSIDE_CHECKOUT = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/root",
  "/home",
  "/tmp",
  "/var",
  "/opt",
] as const;

/**
 * Permissions for every run, written to the run's own `~/.cursor/cli-config.json` (the CLI's
 * global config; see https://cursor.com/docs/cli/reference/permissions and
 * https://cursor.com/docs/cli/reference/configuration).
 *
 * The run also uses `--mode ask`, which is read-only, and never `--force`, so a proposed change
 * isn't applied. These rules are the second layer. Deny rules win over allow rules, so a
 * `.cursor/cli.json` in the checkout (PR content) can't allow anything denied here:
 * - no file writes anywhere;
 * - no shell commands at all, git included (stricter than the review contract, which allows git
 *   reads; the diff and file contents are in the prompt, and the Read tool covers the rest);
 * - no web fetches and no MCP tools.
 *
 * `cursorPermissions` adds the reads outside the checkout to the deny list.
 */
export const CURSOR_PERMISSIONS = {
  allow: ["Read(**)"],
  deny: ["Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"],
} as const;

/** Whether `dir` is `path` or one of its parents. */
function holds(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The run's permissions: `CURSOR_PERMISSIONS`, and no reads outside the checkout at `cwd`.
 * `Read(**)` isn't confined to the workspace the way Claude Code's `--restricted` is, so a
 * prompt-injected model could otherwise read the key from `/proc/self/environ` and encode it
 * into a finding, which the literal-match output check wouldn't catch.
 */
export function cursorPermissions(cwd: string): { allow: string[]; deny: string[] } {
  const checkout = resolve(cwd);
  const outside = OUTSIDE_CHECKOUT.filter((dir) => !holds(dir, checkout));
  return {
    allow: [...CURSOR_PERMISSIONS.allow],
    deny: [...CURSOR_PERMISSIONS.deny, ...outside.map((dir) => `Read(${dir}/**)`), "Read(~/**)"],
  };
}

/**
 * Config directories in the checkout, set aside for the run. In a trusted workspace (which
 * headless runs need, with `--trust`) the CLI loads the project's hooks: commands it runs itself,
 * which the tool deny rules don't cover. A PR could add one to run anything with the key in its
 * environment (https://cursor.com/docs/agent/hooks). Cursor has no flag to skip project hooks or
 * config, so the whole of `.cursor/` (hooks, cli.json, mcp.json, rules, sandbox.json) goes, and
 * `.claude/`, whose settings' hooks Cursor can load too. Their diff is still in the prompt.
 */
export const CURSOR_PROJECT_CONFIG_DIRS = [".cursor", ".claude"] as const;

/** The run's `cli-config.json`, for a checkout at `cwd`. */
export function cursorCliConfig(cwd: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      editor: { vimMode: false },
      permissions: cursorPermissions(cwd),
    },
    null,
    2,
  )}\n`;
}
