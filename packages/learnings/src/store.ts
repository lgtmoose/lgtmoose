/** Learnings as the store keeps them, and the store's port. */

export const LEARNING_KINDS = ["accepted_pattern", "correction", "convention", "scoping"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

export type LearningStatus = "pending" | "active" | "retired";

/**
 * What happened to a learning. `reinforced` and `not_followed` come from outcomes (NIC-1081): a
 * finding whose prompt had the learning was fixed, or one it should have covered was declined.
 */
export type LearningEventType =
  "proposed" | "applied" | "approved" | "retired" | "reinforced" | "not_followed";

/**
 * A GitHub repository permission, as the collaborators API's `role_name` gives it, from most to
 * least. `none`: not a collaborator at all.
 */
export const PERMISSIONS = ["admin", "maintain", "write", "triage", "read", "none"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** A login's role in a GitHub org, as the org memberships API gives it. */
export const ORG_ROLES = ["admin", "member", "none"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * The access that was checked for someone, as recorded: their repo permission for a repo or
 * path learning, `org:<role>` for an org-wide one, or `system` for LGTMoose itself (retiring a
 * learning unused for too long).
 */
export type CheckedPermission = Permission | `org:${OrgRole}` | "system";

/** The actor LGTMoose records for what it does itself, such as retiring unused learnings. */
export const SYSTEM_ACTOR = "lgtmoose";

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
  /**
   * For a learning made from findings people rejected (NIC-1081): the pattern it's about (see
   * `patternKey` in the control app), so it isn't proposed twice.
   */
  patternKey?: string;
  /**
   * Who proposed it, and the access checked for them then, both from GitHub: their permission
   * on `sourceRepo`, or their org role for an org-wide learning.
   */
  author: string;
  authorPermission: CheckedPermission;
  createdAt: Date;
  retiredAt: Date | undefined;
  /** How many review prompts it was added to, and when it last was. */
  hits: number;
  lastUsedAt: Date | undefined;
}

export type NewLearning = Omit<Learning, "id" | "createdAt" | "retiredAt" | "hits" | "lastUsedAt">;

export interface LearningEvent {
  learningId: string;
  type: LearningEventType;
  actor: string;
  /** The access checked for the actor (see `Learning.authorPermission`). */
  actorPermission: CheckedPermission;
  githubCommentId: number | undefined;
  /** For `reinforced` and `not_followed`: the finding it's about. */
  findingId?: string;
  createdAt: Date;
}

export type NewLearningEvent = Omit<LearningEvent, "learningId" | "createdAt">;

/** What became of a finding whose batch had learnings in its prompt (NIC-1081). */
export interface LearningOutcome {
  type: "reinforced" | "not_followed";
  findingId: string;
  /** The reply that fixed or declined it, when there was one. */
  githubCommentId?: number;
}

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
  /**
   * How many of `author`'s learnings in `org` are pending, leaving out the one proposed in
   * `except` (a source repo and comment), so a retried proposal isn't counted against itself.
   * Logins are compared case-insensitively.
   */
  countPending(
    org: string,
    author: string,
    except?: { sourceRepo: string; sourceCommentId: number },
  ): Promise<number>;
  /** Oldest first. */
  events(learningId: string): Promise<LearningEvent[]>;
  /** Of `ids`, the learnings without an embedding from `model` (none, or another model's). */
  missingEmbeddings(ids: readonly string[], model: string): Promise<string[]>;
  /** Stores a learning's embedding and the model it came from. */
  setEmbedding(id: string, model: string, embedding: readonly number[]): Promise<void>;
  /**
   * Of `ids`, the `limit` learnings with an embedding from `model` nearest to `embedding` by
   * cosine distance (pgvector `<=>`), nearest first. Learnings without one are left out.
   */
  nearest(
    ids: readonly string[],
    model: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<string[]>;
  /** Counts a use of each learning: `hits` goes up by one and `lastUsedAt` becomes `at`. */
  recordUse(ids: readonly string[], at: Date): Promise<void>;
  /**
   * Records an outcome on each of `ids` that isn't retired, with an event by LGTMoose
   * (`SYSTEM_ACTOR`): `reinforced` also counts a hit, `not_followed` only records the event.
   * Each learning gets one event per finding and type, so a retried post doesn't add another.
   */
  recordOutcome(ids: readonly string[], outcome: LearningOutcome, at: Date): Promise<void>;
  /** The repo's pending and active learnings with a `patternKey`, newest first. */
  patterned(repo: string): Promise<Learning[]>;
  /** How many `not_followed` events each of `org`'s learnings got since `since`, by ID. */
  notFollowedSince(org: string, since: Date): Promise<Map<string, number>>;
  /**
   * Active learnings last used (or, never used, created) before `before`, oldest first, at
   * most `limit`.
   */
  unusedSince(before: Date, limit: number): Promise<Learning[]>;
}

/** Cosine distance, as pgvector's `<=>` computes it: 1 - cosine similarity. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / Math.sqrt(na * nb);
}

/** An in-memory `LearningStore`, for tests and for callers' tests. */
export function memoryLearningStore(now: () => Date = () => new Date()): LearningStore & {
  all(): Learning[];
} {
  const rows = new Map<string, Learning>();
  const vectors = new Map<string, { model: string; embedding: number[] }>();
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
        hits: 0,
        lastUsedAt: undefined,
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
    async countPending(org, author, except) {
      return [...rows.values()].filter(
        (row) =>
          row.org === org &&
          row.status === "pending" &&
          row.author.toLowerCase() === author.toLowerCase() &&
          !(
            except !== undefined &&
            row.sourceRepo === except.sourceRepo &&
            row.sourceCommentId === except.sourceCommentId
          ),
      ).length;
    },
    async events(learningId) {
      return history.filter((event) => event.learningId === learningId).map((e) => ({ ...e }));
    },
    async missingEmbeddings(ids, model) {
      return ids.filter((id) => rows.has(id) && vectors.get(id)?.model !== model);
    },
    async setEmbedding(id, model, embedding) {
      if (rows.has(id)) vectors.set(id, { model, embedding: [...embedding] });
    },
    async nearest(ids, model, embedding, limit) {
      return ids
        .flatMap((id) => {
          const vector = vectors.get(id);
          return vector === undefined || vector.model !== model
            ? []
            : [{ id, distance: cosineDistance(vector.embedding, embedding) }];
        })
        .sort((a, b) => a.distance - b.distance)
        .slice(0, limit)
        .map((entry) => entry.id);
    },
    async recordUse(ids, at) {
      for (const id of new Set(ids)) {
        const row = rows.get(id);
        if (row === undefined) continue;
        row.hits += 1;
        row.lastUsedAt = at;
      }
    },
    async recordOutcome(ids, outcome, at) {
      for (const id of new Set(ids)) {
        const row = rows.get(id);
        if (row === undefined || row.status === "retired") continue;
        const seen = history.some(
          (event) =>
            event.learningId === id &&
            event.type === outcome.type &&
            event.findingId === outcome.findingId,
        );
        if (seen) continue;
        if (outcome.type === "reinforced") {
          row.hits += 1;
          row.lastUsedAt = at;
        }
        history.push({
          learningId: id,
          type: outcome.type,
          actor: SYSTEM_ACTOR,
          actorPermission: "system",
          githubCommentId: outcome.githubCommentId,
          findingId: outcome.findingId,
          createdAt: at,
        });
      }
    },
    async patterned(repo) {
      return [...rows.values()]
        .filter(
          (row) => row.repo === repo && row.patternKey !== undefined && row.status !== "retired",
        )
        .reverse()
        .map((row) => ({ ...row }));
    },
    async notFollowedSince(org, since) {
      const counts = new Map<string, number>();
      for (const event of history) {
        if (event.type !== "not_followed" || event.createdAt.getTime() < since.getTime()) continue;
        if (rows.get(event.learningId)?.org !== org) continue;
        counts.set(event.learningId, (counts.get(event.learningId) ?? 0) + 1);
      }
      return counts;
    },
    async unusedSince(before, limit) {
      const since = (row: Learning) => (row.lastUsedAt ?? row.createdAt).getTime();
      return [...rows.values()]
        .filter((row) => row.status === "active" && since(row) < before.getTime())
        .sort((a, b) => since(a) - since(b))
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    all() {
      return [...rows.values()].map((row) => ({ ...row }));
    },
  };
}
