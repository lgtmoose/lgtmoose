/** Whether the App belongs to a GitHub organization or a personal account. */
export type OwnerKind = "org" | "user";

export interface Owner {
  login: string;
  kind: OwnerKind;
}

/**
 * Placeholder webhook URL. The real one only exists after `lgtmoose deploy` (NIC-803), which
 * points the App's webhook at the gateway and turns it on. `.invalid` can never resolve.
 */
export const PLACEHOLDER_WEBHOOK_URL = "https://example.invalid/webhooks/github";

/** Events the reviewer reacts to. Each needs one of the permissions below. */
export const APP_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
] as const;

type Access = "read" | "write";

/**
 * Least privilege for reviewing: read code, write reviews, comments, labels and check runs.
 * `members` lets the learning policy check whether a commenter belongs to the org.
 */
const PERMISSIONS = {
  contents: "read",
  metadata: "read",
  members: "read",
  pull_requests: "write",
  issues: "write",
  checks: "write",
} as const satisfies Record<string, Access>;

export interface AppManifest {
  name: string;
  url: string;
  description: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Partial<Record<keyof typeof PERMISSIONS, Access>>;
  default_events: string[];
}

/** The GitHub App manifest: https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest */
export function buildManifest(options: {
  name: string;
  owner: Owner;
  redirectUrl: string;
}): AppManifest {
  // `members` is an organization permission. GitHub rejects it on an App owned by a user.
  const { members, ...repoPermissions } = PERMISSIONS;
  const permissions =
    options.owner.kind === "org" ? { ...repoPermissions, members } : repoPermissions;
  return {
    name: options.name,
    url: "https://github.com/lgtmoose/lgtmoose",
    description: "Self-hosted AI pull request reviewer (LGTMoose).",
    hook_attributes: { url: PLACEHOLDER_WEBHOOK_URL, active: false },
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: permissions,
    default_events: [...APP_EVENTS],
  };
}

/** Where the manifest form is posted. `state` comes back on the redirect and guards against CSRF. */
export function newAppUrl(owner: Owner, state: string): string {
  const base =
    owner.kind === "org"
      ? `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** GitHub App names are unique across GitHub and at most 34 characters long. */
export const MAX_APP_NAME_LENGTH = 34;

/**
 * A plain "lgtmoose" is almost certainly taken, since names are global, so default to one
 * scoped to the owner.
 */
export function defaultAppName(ownerLogin: string): string {
  return `lgtmoose-${ownerLogin.toLowerCase()}`.slice(0, MAX_APP_NAME_LENGTH).replace(/-+$/, "");
}

/** Where to install the App. Works for both org- and user-owned Apps. */
export function installUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
