import type { OrgRole } from "@lgtmoose/learnings";
import { GitHubError, type GitHubClient } from "@lgtmoose/poster";
import { toPermission, type Permission } from "./thread-policy.js";

/**
 * Who someone is on GitHub, as LGTMoose's trust rules read it: their permission on a repository
 * and their role in an org. Shared by the post step (who resolved a thread) and the
 * conversation handler (who sent a command). A read that fails counts as no access, so a rule
 * that needs access is never passed on an error.
 */

type Log = (message: string, fields?: Record<string, unknown>) => void;

/** The collaborators API: `role_name` (with maintain and triage), else `permission`. */
export async function collaboratorPermission(
  client: Pick<GitHubClient, "request">,
  target: { owner: string; repo: string },
  login: string,
  log: Log,
): Promise<Permission> {
  const path = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/collaborators/${encodeURIComponent(login)}/permission`;
  try {
    const reply = await client.request<{ permission?: unknown; role_name?: unknown }>("GET", path);
    // `role_name` has maintain and triage; `permission` folds them into write and read.
    const role = typeof reply.role_name === "string" ? reply.role_name : undefined;
    const permission = typeof reply.permission === "string" ? reply.permission : undefined;
    const named = toPermission(role);
    return named !== "none" ? named : toPermission(permission);
  } catch (error) {
    // Not a collaborator: no access. Anything else is a failed read, treated the same way.
    log("collaborator permission unread", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "none";
  }
}

/**
 * The org memberships API: an active owner is `admin`, an active member `member`. An account
 * that isn't an org (a user) has no memberships: only that user counts, as `admin`.
 */
export async function orgRole(
  client: Pick<GitHubClient, "request">,
  org: string,
  login: string,
  log: Log,
): Promise<OrgRole> {
  try {
    const reply = await client.request<{ role?: unknown; state?: unknown }>(
      "GET",
      `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`,
    );
    if (reply.state !== "active") return "none";
    if (reply.role === "admin") return "admin";
    return reply.role === "member" ? "member" : "none";
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      // Not a member, or not an org at all: a user account's owner is the user.
      try {
        const account = await client.request<{ type?: unknown; login?: unknown }>(
          "GET",
          `/users/${encodeURIComponent(org)}`,
        );
        const name = typeof account.login === "string" ? account.login : undefined;
        const isOwner = account.type === "User" && name?.toLowerCase() === login.toLowerCase();
        return isOwner ? "admin" : "none";
      } catch (inner) {
        log("account unread", { error: inner instanceof Error ? inner.message : String(inner) });
        return "none";
      }
    }
    log("org membership unread", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "none";
  }
}
