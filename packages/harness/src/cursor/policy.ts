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
 */
export const CURSOR_PERMISSIONS = {
  allow: ["Read(**)"],
  deny: ["Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"],
} as const;

/** The run's `cli-config.json`. */
export function cursorCliConfig(): string {
  return `${JSON.stringify(
    {
      version: 1,
      editor: { vimMode: false },
      permissions: CURSOR_PERMISSIONS,
    },
    null,
    2,
  )}\n`;
}
