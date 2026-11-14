/** Learnings as the store keeps them, and the store's port. */

export const LEARNING_KINDS = ["accepted_pattern", "correction", "convention", "scoping"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

export type LearningStatus = "pending" | "active" | "retired";

export type LearningEventType = "proposed" | "applied" | "approved" | "retired";

/**
 * A GitHub repository permission, as the collaborators API's `role_name` gives it, from most to
 * least. `none`: not a collaborator at all.
 */
export const PERMISSIONS = ["admin", "maintain", "write", "triage", "read", "none"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Learning {
  id: string;
  /** The GitHub org or user it belongs to. */
  org: string;
  /** owner/name; undefined for an org-wide learning. */
  repo: string | undefined;
  /** Limits it to matching paths in `repo`; undefined for the whole repo. */
  pathGlob: string | undefined;
  kind: LearningKind;
  /** The finding category it's about, if any. */
  category: string | undefined;
  /** Redacted. */
  text: string;
  status: LearningStatus;
  /** Where it was proposed: owner/name, the PR and the comment. */
  sourceRepo: string;
  sourcePr: number | undefined;
  sourceCommentId: number | undefined;
  /** Who proposed it, and their permission on `sourceRepo` then, both from GitHub. */
  author: string;
  authorPermission: Permission;
  createdAt: Date;
  retiredAt: Date | undefined;
}

export type NewLearning = Omit<Learning, "id" | "createdAt" | "retiredAt">;

export interface LearningEvent {
  learningId: string;
  type: LearningEventType;
  actor: string;
  actorPermission: Permission;
  githubCommentId: number | undefined;
  createdAt: Date;
}

export type NewLearningEvent = Omit<LearningEvent, "learningId" | "createdAt">;

export interface LearningFilter {
  org: string;
  /** Only this repo's learnings and the org-wide ones; every repo's when left out. */
  repo?: string;
  status?: LearningStatus;
}

/** `learnings` and `learning_events`. */
export interface LearningStore {
  /**
   * Stores a learning with its first events. A learning from the same source comment is never
   * stored twice: then the stored one is returned, `created` false, and no events are added.
   */
  insert(
    learning: NewLearning,
    events: readonly NewLearningEvent[],
  ): Promise<{ learning: Learning; created: boolean }>;
  get(id: string): Promise<Learning | undefined>;
  /**
   * Moves a learning to `to` with `event`, only while its status is one of `from`. Returns the
   * learning as it is now, or undefined when it wasn't in `from` (or doesn't exist).
   */
  transition(
    id: string,
    from: readonly LearningStatus[],
    to: LearningStatus,
    event: NewLearningEvent,
  ): Promise<Learning | undefined>;
  /** Newest first. */
  list(filter: LearningFilter): Promise<Learning[]>;
  /** Oldest first. */
  events(learningId: string): Promise<LearningEvent[]>;
}

/** An in-memory `LearningStore`, for tests and for callers' tests. */
export function memoryLearningStore(now: () => Date = () => new Date()): LearningStore & {
  all(): Learning[];
} {
  const rows = new Map<string, Learning>();
  const history: LearningEvent[] = [];
  let next = 1;
  const addEvents = (learningId: string, events: readonly NewLearningEvent[]) => {
    for (const event of events) history.push({ ...event, learningId, createdAt: now() });
  };
  return {
    async insert(learning, events) {
      if (learning.sourceCommentId !== undefined) {
        const existing = [...rows.values()].find(
          (row) =>
            row.sourceRepo === learning.sourceRepo &&
            row.sourceCommentId === learning.sourceCommentId,
        );
        if (existing !== undefined) return { learning: { ...existing }, created: false };
      }
      const row: Learning = {
        ...learning,
        id: `learning-${next++}`,
        createdAt: now(),
        retiredAt: undefined,
      };
      rows.set(row.id, row);
      addEvents(row.id, events);
      return { learning: { ...row }, created: true };
    },
    async get(id) {
      const row = rows.get(id);
      return row === undefined ? undefined : { ...row };
    },
    async transition(id, from, to, event) {
      const row = rows.get(id);
      if (row === undefined || !from.includes(row.status)) return undefined;
      row.status = to;
      if (to === "retired") row.retiredAt = now();
      addEvents(id, [event]);
      return { ...row };
    },
    async list({ org, repo, status }) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.org === org &&
            (repo === undefined || row.repo === undefined || row.repo === repo) &&
            (status === undefined || row.status === status),
        )
        .reverse()
        .map((row) => ({ ...row }));
    },
    async events(learningId) {
      return history.filter((event) => event.learningId === learningId).map((e) => ({ ...e }));
    },
    all() {
      return [...rows.values()].map((row) => ({ ...row }));
    },
  };
}
