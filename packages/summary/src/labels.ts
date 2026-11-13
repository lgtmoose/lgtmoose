/**
 * The GitHub calls label sync needs, for one PR. The poster (NIC-816) implements it with the
 * installation token; tests use a fake.
 */
export interface LabelClient {
  /** Names of every label defined in the repository. */
  listRepoLabels(): Promise<string[]>;
  /** Names of the labels on the PR. */
  listPrLabels(): Promise<string[]>;
  /** Adds labels to the PR. Every name must already exist in the repository. */
  addPrLabels(labels: readonly string[]): Promise<void>;
  /** Removes one label from the PR. */
  removePrLabel(label: string): Promise<void>;
}

export interface LabelSyncInput {
  /** The status label the PR should carry. One of `statusLabels`. */
  target: string;
  /** All three status labels from .lgtmoose.yaml (see `statusLabels` in @lgtmoose/config). */
  statusLabels: readonly string[];
}

export interface LabelSyncResult {
  /**
   * The PR carries the target label and no other status label. False when the target label is
   * missing from the repository, or the labels didn't match when read back.
   */
  ok: boolean;
  added: string[];
  removed: string[];
  /** Status labels the repository doesn't have. They are never created. */
  missing: string[];
  /** The PR's labels as read back after the changes. */
  labels: string[];
  /** What went wrong, in plain words: a missing label, or labels that didn't match. */
  problem?: string;
}

/** GitHub label names are unique regardless of case. */
const key = (label: string) => label.toLowerCase();

/**
 * Puts exactly one status label on the PR: adds the target, removes the other status labels,
 * and leaves every other label alone. Only labels that exist in the repository are used; a
 * missing one is reported, never created. The other status labels are removed even when the
 * target is missing, since a stale status is worse than none.
 *
 * Afterwards the PR's labels are read back. If they don't match (someone edited them at the
 * same time), the sync is tried once more before it reports the problem.
 */
export async function syncStatusLabel(
  client: LabelClient,
  input: LabelSyncInput,
): Promise<LabelSyncResult> {
  const statusKeys = new Set(input.statusLabels.map(key));
  if (!statusKeys.has(key(input.target))) {
    throw new Error(`The target label "${input.target}" isn't one of the status labels.`);
  }
  const repo = new Map((await client.listRepoLabels()).map((name) => [key(name), name]));
  const missing = input.statusLabels.filter((label) => !repo.has(key(label)));
  // The repository's own spelling, so the label GitHub stores is the one that exists.
  const target = repo.get(key(input.target));

  const added: string[] = [];
  const removed: string[] = [];
  let labels: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await client.listPrLabels();
    const stale = current.filter(
      (label) => statusKeys.has(key(label)) && key(label) !== key(input.target),
    );
    for (const label of stale) {
      await client.removePrLabel(label);
      removed.push(label);
    }
    if (target !== undefined && !current.some((label) => key(label) === key(target))) {
      await client.addPrLabels([target]);
      added.push(target);
    }
    labels = await client.listPrLabels();
    if (matches(labels, statusKeys, target)) {
      return { ok: target !== undefined, added, removed, missing, labels, ...problemFor(missing) };
    }
  }
  return {
    ok: false,
    added,
    removed,
    missing,
    labels,
    problem:
      "The PR's labels didn't match after two tries; someone may be changing them at the same time.",
  };
}

function matches(
  labels: readonly string[],
  statusKeys: ReadonlySet<string>,
  target?: string,
): boolean {
  const status = labels.filter((label) => statusKeys.has(key(label))).map(key);
  return target === undefined
    ? status.length === 0
    : status.length === 1 && status[0] === key(target);
}

function problemFor(missing: readonly string[]): { problem?: string } {
  if (missing.length === 0) return {};
  return {
    problem: `The repository has no ${missing.map((label) => `"${label}"`).join(", ")} label. LGTMoose doesn't create labels; add them in the repository's settings.`,
  };
}
