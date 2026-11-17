import { isProtectedCategory, mentionsProtectedTopic } from "@lgtmoose/core";
import { z } from "zod";
import { redactSensitive, type RedactionKind } from "./redact.js";
import {
  LEARNING_KINDS,
  ORG_ROLES,
  PERMISSIONS,
  type CheckedPermission,
  type Learning,
  type LearningKind,
  type LearningStore,
  type OrgRole,
  type Permission,
} from "./store.js";

/**
 * The write policy for learnings. Memory writes are the main prompt-injection risk, so the rules
 * are code, not prompt:
 *
 * - **Only a proposal comes from the model** (or a comment): its kind, text, category and how
 *   wide it applies. Who proposed it, where, and their permission come from GitHub
 *   (`LearningSource`, `PermissionReader`), never from the proposal.
 * - **Applied only with the access its scope needs.** A repo or path learning is active at once
 *   when its author has write access or higher on the repo. An org-wide one changes every repo
 *   in the org, so it needs an owner of the org (`OrgRoleReader`): admin on one repo isn't
 *   enough, since anyone who creates a repo is admin on it. Otherwise it waits as `pending`
 *   until someone with that access approves it. Approving and forgetting need the same access.
 * - **Protected categories can't be suppressed.** A learning of a kind that can quiet findings
 *   (`accepted_pattern`, `scoping`, `correction`) can't name a protected category. Retrieval
 *   (NIC-837) must also never let a learning suppress a protected-category finding:
 *   `mayLearningSuppress`, for every finding, learnings with no category included.
 * - **Learning text stays untrusted.** It's proposal text from a comment or the model, so
 *   retrieval puts it in an untrusted block in the prompt, never with the instructions.
 * - **Redacted before it's stored**, pending ones included: credentials and personal data in the
 *   text are replaced (`redactSensitive`).
 * - **`forget` retires**, it never deletes: the row and its history stay.
 */

/** Reads a GitHub login's permission on a repo (the collaborators API), from GitHub. */
export type PermissionReader = (repo: string, login: string) => Promise<Permission>;

/**
 * Reads a GitHub login's role in an org (the org memberships API: `admin` is an owner), from
 * GitHub. For an account that's a user, not an org, only that user counts as `admin`; anyone
 * else is `none`.
 */
export type OrgRoleReader = (org: string, login: string) => Promise<OrgRole>;

export interface LearningDeps {
  store: LearningStore;
  permissions: PermissionReader;
  orgRoles: OrgRoleReader;
  /**
   * The most pending learnings one author may have in an org (`learnings.maxPendingPerAuthor`,
   * default `DEFAULT_MAX_PENDING_PER_AUTHOR`). Anyone can propose one, so on a public repository
   * this stops one person filling the queue. Authors whose learnings apply at once aren't counted.
   */
  maxPendingPerAuthor?: number;
}

export const DEFAULT_MAX_PENDING_PER_AUTHOR = 5;

/** Where a proposal came from: GitHub's facts about the comment, never the model's. */
export interface LearningSource {
  /** owner/name */
  repo: string;
  pr?: number;
  commentId?: number;
  /** The comment's author, as GitHub reported it. */
  author: string;
}

/** The longest learning text kept. */
export const MAX_LEARNING_TEXT = 1000;
const MAX_PATH_GLOB = 200;

/**
 * What the model (or a person's `learn:` comment, once parsed) proposes. Strict: it can't carry
 * an author, a permission, a status or a repository.
 */
export const learningProposalSchema = z
  .object({
    kind: z.enum(LEARNING_KINDS),
    text: z.string().trim().min(1).max(MAX_LEARNING_TEXT),
    /** A finding category, such as `security` or `tenant_scoping`. */
    category: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/)
      .optional(),
    /**
     * How wide it applies: the whole org, the source repo, or paths in the source repo. The
     * repo is always the one it was proposed on.
     */
    scope: z.discriminatedUnion("level", [
      z.object({ level: z.literal("org") }).strict(),
      z.object({ level: z.literal("repo") }).strict(),
      z
        .object({
          level: z.literal("path"),
          pathGlob: z
            .string()
            .min(1)
            .max(MAX_PATH_GLOB)
            .refine(isRepoGlob, "a path glob inside the repository"),
        })
        .strict(),
    ]),
  })
  .strict();

export type LearningProposal = z.infer<typeof learningProposalSchema>;

/** A relative glob within the repo: no absolute paths, `..`, backslashes or control chars. */
function isRepoGlob(glob: string): boolean {
  if (glob.startsWith("/") || glob.includes("\\")) return false;
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(glob)) return false;
  return !glob.split("/").some((part) => part === ".." || part === ".");
}

/** Kinds that can quiet a finding, and so can't name a protected category. */
const SUPPRESSING_KINDS: ReadonlySet<LearningKind> = new Set([
  "accepted_pattern",
  "scoping",
  "correction",
]);

/**
 * Whether a learning may quiet a finding of `category`: never for a protected one, whatever the
 * learning says. Retrieval (NIC-837) checks this for every finding a learning would suppress.
 */
export function mayLearningSuppress(category: string): boolean {
  return !isProtectedCategory(category);
}

const RANK: Record<Permission, number> = {
  admin: 5,
  maintain: 4,
  write: 3,
  triage: 2,
  read: 1,
  none: 0,
};

/** A permission string from GitHub as a `Permission`; anything unknown counts as `none`. */
export function toPermission(value: string | undefined): Permission {
  return (PERMISSIONS as readonly string[]).includes(value ?? "") ? (value as Permission) : "none";
}

/** A recorded permission (`Permission` or `org:<role>`); anything unknown counts as `none`. */
export function toCheckedPermission(value: string | undefined): CheckedPermission {
  if (value === "system") return "system";
  if (value?.startsWith("org:") === true) {
    const role = value.slice(4);
    return (ORG_ROLES as readonly string[]).includes(role)
      ? (`org:${role}` as CheckedPermission)
      : "org:none";
  }
  return toPermission(value);
}

/**
 * Whether `login` has the access a learning of this scope needs, read from GitHub: write on the
 * repo it was proposed on for a repo or path learning, an owner of the org for an org-wide one.
 */
async function access(
  deps: LearningDeps,
  learning: { org: string; repo: string | undefined; sourceRepo: string },
  login: string,
): Promise<{ checked: CheckedPermission; ok: boolean; required: string }> {
  if (learning.repo === undefined) {
    const role = await deps.orgRoles(learning.org, login);
    return {
      checked: `org:${role}`,
      ok: role === "admin",
      required: `an owner of ${learning.org}`,
    };
  }
  const permission = await deps.permissions(learning.sourceRepo, login);
  return {
    checked: permission,
    ok: atLeast(permission, "write"),
    required: `write access on ${learning.sourceRepo}`,
  };
}

function atLeast(permission: Permission, required: Permission): boolean {
  return RANK[permission] >= RANK[required];
}

function splitRepo(repo: string): { owner: string; full: string } {
  const full = repo.trim().toLowerCase();
  const [owner, name, ...rest] = full.split("/");
  if (owner === undefined || owner === "" || name === undefined || name === "" || rest.length > 0) {
    throw new Error(`Not a repository: ${repo}`);
  }
  return { owner, full };
}

export type ProposeResult =
  | {
      outcome: "active" | "pending";
      learning: Learning;
      created: boolean;
      redacted: RedactionKind[];
    }
  | { outcome: "refused"; reason: string };

/** How a proposal is stored, set by the caller's code (never by the proposal). */
export interface ProposeOptions {
  /**
   * Stored pending even when its author has the access, for a person to approve: a learning
   * made from several people's rejections, not all of whom had write access (NIC-1081).
   */
  requireApproval?: boolean;
  /** The pattern of rejected findings it's made from (`Learning.patternKey`). */
  patternKey?: string;
}

/**
 * Stores a proposed learning: refused when it doesn't validate or would let a protected category
 * be suppressed; otherwise redacted and stored, active when its author has the access (and
 * `options.requireApproval` isn't set) and pending when not. A second proposal from the same
 * comment returns the first.
 */
export async function proposeLearning(
  deps: LearningDeps,
  proposal: unknown,
  source: LearningSource,
  options: ProposeOptions = {},
): Promise<ProposeResult> {
  const parsed = learningProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return {
      outcome: "refused",
      reason: `not a valid learning (${parsed.error.issues[0]?.message ?? "invalid"})`,
    };
  }
  const { kind, text, category, scope } = parsed.data;
  if (category !== undefined && SUPPRESSING_KINDS.has(kind) && isProtectedCategory(category)) {
    return {
      outcome: "refused",
      reason: `a ${kind} learning can't be about ${category}: findings in protected categories are never suppressed`,
    };
  }
  if (category === undefined && SUPPRESSING_KINDS.has(kind) && mentionsProtectedTopic(text)) {
    const article = /^[aeiou]/i.test(kind) ? "an" : "a";
    return {
      outcome: "refused",
      reason: `${article} ${kind} learning that mentions a protected topic needs a category`,
    };
  }
  const { owner, full } = splitRepo(source.repo);
  const repo = scope.level === "org" ? undefined : full;
  const pathGlob = scope.level === "path" ? scope.pathGlob : undefined;
  const redacted = redactSensitive(text);
  // From GitHub, at the time it's proposed.
  const { checked: authorPermission, ok: hasAccess } = await access(
    deps,
    { org: owner, repo, sourceRepo: full },
    source.author,
  );
  const active = hasAccess && options.requireApproval !== true;
  // Authors with the access aren't limited, also when this one waits for approval.
  if (!hasAccess) {
    const limit = deps.maxPendingPerAuthor ?? DEFAULT_MAX_PENDING_PER_AUTHOR;
    // A retried proposal of a stored one isn't counted against itself.
    const pending = await deps.store.countPending(
      owner,
      source.author,
      source.commentId === undefined
        ? undefined
        : { sourceRepo: full, sourceCommentId: source.commentId },
    );
    if (pending >= limit) {
      return {
        outcome: "refused",
        reason: `${source.author} already has ${pending} pending learnings here (the limit is ${limit}); ask someone with write access to approve or forget some first`,
      };
    }
  }
  const { learning, created } = await deps.store.insert(
    {
      org: owner,
      repo,
      pathGlob,
      kind,
      category,
      text: redacted.text,
      status: active ? "active" : "pending",
      sourceRepo: full,
      sourcePr: source.pr,
      sourceCommentId: source.commentId,
      ...(options.patternKey === undefined ? {} : { patternKey: options.patternKey }),
      author: source.author,
      authorPermission,
    },
    [
      {
        type: "proposed",
        actor: source.author,
        actorPermission: authorPermission,
        githubCommentId: source.commentId,
      },
      ...(active
        ? [
            {
              type: "applied" as const,
              actor: source.author,
              actorPermission: authorPermission,
              githubCommentId: source.commentId,
            },
          ]
        : []),
    ],
  );
  return {
    outcome: learning.status === "active" ? "active" : "pending",
    learning,
    created,
    redacted: redacted.found,
  };
}

/** Who's acting on a learning, from GitHub: the login and, if any, the comment they did it in. */
export interface LearningActor {
  login: string;
  commentId?: number;
}

export type ChangeResult =
  | { outcome: "done"; learning: Learning }
  | { outcome: "refused"; reason: string }
  | { outcome: "unchanged"; learning: Learning | undefined };

/**
 * Makes a pending learning active, for someone with the access its scope needs: write on the
 * repo it was proposed on, or an owner of the org for an org-wide one.
 */
export async function approveLearning(
  deps: LearningDeps,
  id: string,
  actor: LearningActor,
): Promise<ChangeResult> {
  return change(deps, id, actor, ["pending"], "active", "approved");
}

/**
 * Retires a learning (`forget`), pending or active, for someone with the access its scope needs.
 * Its row and history stay; it's just no longer used.
 */
export async function forgetLearning(
  deps: LearningDeps,
  id: string,
  actor: LearningActor,
): Promise<ChangeResult> {
  return change(deps, id, actor, ["pending", "active"], "retired", "retired");
}

async function change(
  deps: LearningDeps,
  id: string,
  actor: LearningActor,
  from: readonly ("pending" | "active")[],
  to: "active" | "retired",
  type: "approved" | "retired",
): Promise<ChangeResult> {
  const learning = await deps.store.get(id);
  if (learning === undefined) return { outcome: "refused", reason: "no such learning" };
  const { checked: permission, ok, required } = await access(deps, learning, actor.login);
  if (!ok) return { outcome: "refused", reason: `needs ${required} (has ${permission})` };
  if (!(from as readonly string[]).includes(learning.status)) {
    return { outcome: "unchanged", learning };
  }
  const changed = await deps.store.transition(id, from, to, {
    type,
    actor: actor.login,
    actorPermission: permission,
    githubCommentId: actor.commentId,
  });
  return changed === undefined
    ? { outcome: "unchanged", learning: await deps.store.get(id) }
    : { outcome: "done", learning: changed };
}
