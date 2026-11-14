import { isProtectedCategory, type Severity } from "@lgtmoose/core";

/**
 * Who may clear a finding by resolving its review thread. Resolving a thread takes its finding
 * out of the decision, so for findings that hold a merge it can't be self-service: a blocking
 * finding, or one in a protected category, counts as resolved only when someone other than
 * the PR's author, with write access or higher on the repository, resolved it. Anyone may
 * resolve a should_fix or nit finding, the author included.
 */

/** A login's permission on a repository, as GitHub's collaborators API reports it. */
export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

const RANK: Record<Permission, number> = {
  admin: 5,
  maintain: 4,
  write: 3,
  triage: 2,
  read: 1,
  none: 0,
};

/** GitHub's permission text as a `Permission`; anything else is `none`. */
export function toPermission(value: string | undefined): Permission {
  return value !== undefined && Object.hasOwn(RANK, value) ? (value as Permission) : "none";
}

/** Whether resolving this finding's thread needs a trusted resolver. */
export function needsTrustedResolver(finding: {
  severity: Severity;
  ruleCategory: string;
}): boolean {
  return finding.severity === "blocking" || isProtectedCategory(finding.ruleCategory);
}

/** Why a resolution doesn't count, or undefined when it does. */
export type HeldReason = "author" | "unknown_resolver" | "no_write_access";

/**
 * Whether a resolution by `resolver` counts for this finding: always for one that doesn't need
 * a trusted resolver; otherwise only for someone known, other than the PR's author, with write
 * access or higher. `permission` is read only when it's needed (GitHub logins are
 * case-insensitive).
 */
export async function resolutionHeld(
  finding: { severity: Severity; ruleCategory: string },
  resolver: string | undefined,
  prAuthor: string,
  permission: (login: string) => Promise<Permission>,
): Promise<HeldReason | undefined> {
  if (!needsTrustedResolver(finding)) return undefined;
  if (resolver === undefined || resolver === "") return "unknown_resolver";
  if (resolver.toLowerCase() === prAuthor.toLowerCase()) return "author";
  return RANK[await permission(resolver)] >= RANK.write ? undefined : "no_write_access";
}
