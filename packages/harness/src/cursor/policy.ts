import { isInside } from "../paths.js";

/**
 * Top-level directories denied as a second layer behind the read allowlist: the CLI's own
 * environment (`/proc/self/environ` holds `CURSOR_API_KEY`), system and user files, and other
 * mounts. One that holds the run's workspace can't be denied (deny beats allow), so it's left
 * out; the allowlist still confines reads there.
 */
export const DENIED_ROOTS = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/root",
  "/home",
  "/Users",
  "/tmp",
  "/var",
  "/opt",
  "/usr",
  "/run",
  "/srv",
  "/mnt",
  "/media",
  "/boot",
  "/lib",
  "/bin",
  "/sbin",
  "/snap",
  "/work",
  "/private",
  "/Volumes",
] as const;

/**
 * Tool rules for every run (https://cursor.com/docs/cli/reference/permissions). The run also
 * uses `--mode ask`, which is read-only, and never `--force`, so a proposed change isn't applied.
 * Deny rules win over allow rules, so nothing in the workspace can allow what's denied here:
 * - no file writes anywhere;
 * - no shell commands at all, git included (stricter than the review contract, which allows git
 *   reads; the diff and file contents are in the prompt, and the Read tool covers the rest);
 * - no web fetches and no MCP tools.
 */
export const CURSOR_DENIED_TOOLS = ["Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"] as const;

/**
 * The run's permissions for a workspace at `workspace` (a real, absolute path). Reads are an
 * allowlist of the workspace alone, given as an absolute glob, which Cursor's permission and
 * sandbox docs describe (https://cursor.com/docs/agent/security/run-modes); confirm against the
 * pinned CLI in the smoke test (NIC-853). There is no `Read(**)`: unlike Claude Code's
 * `--restricted`, it isn't confined to the workspace, so a prompt-injected model could read the
 * key from `/proc/self/environ` and encode it into a finding.
 */
export function cursorPermissions(workspace: string): { allow: string[]; deny: string[] } {
  const denied = DENIED_ROOTS.filter((dir) => !isInside(dir, workspace));
  return {
    allow: [`Read(${workspace}/**)`],
    deny: [...CURSOR_DENIED_TOOLS, ...denied.map((dir) => `Read(${dir}/**)`), "Read(~/**)"],
  };
}

/** The run's `cli-config.json`, for a workspace at `workspace` (a real, absolute path). */
export function cursorCliConfig(workspace: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      editor: { vimMode: false },
      permissions: cursorPermissions(workspace),
    },
    null,
    2,
  )}\n`;
}
