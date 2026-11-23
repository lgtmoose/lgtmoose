/**
 * Outcome learning from findings declined through the CLI or the dashboard (NIC-1140). The
 * dashboard records the decline (with `learn_pending`) but holds no GitHub App access, which the
 * learnings policy needs to check permissions; the reconciler does, so it learns from them on its
 * next run, as it would from a decline on a thread, and clears the flag.
 */

/** A decline that outcome learning hasn't read yet. */
export interface PendingAnswer {
  eventId: string;
  findingId: string;
  installationId: number;
  repo: string;
}

export interface AnswerLearningStore {
  /**
   * Declines waiting for outcome learning, the least tried first and then the oldest, at most
   * `limit`: one whose learning keeps failing never holds up the rest.
   */
  pendingAnswers(limit: number): Promise<PendingAnswer[]>;
  /** Marks them read. */
  answersLearned(eventIds: readonly string[]): Promise<void>;
  /**
   * Counts a failed attempt on each, and stops waiting on those tried `maxAttempts` times.
   * Returns those it gave up on.
   */
  answersFailed(eventIds: readonly string[], maxAttempts: number): Promise<string[]>;
}

/** The most declines read in one reconciler run. */
export const ANSWERS_PER_RUN = 50;
/** Attempts at learning from one decline before it's given up (the App was uninstalled, say). */
export const MAX_ANSWER_ATTEMPTS = 5;

export interface AnswerLearningDeps {
  store: AnswerLearningStore;
  rejected(
    installationId: number,
    repo: string,
    rejected: readonly { findingId: string }[],
  ): Promise<void>;
  log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Learns from the declines given through the CLI or the dashboard, per repository, and marks
 * each read once its repository's learning ran. A repository whose learning fails keeps its
 * declines for the next run. Returns how many were read.
 */
export async function learnFromAnswers(
  deps: AnswerLearningDeps,
  limit = ANSWERS_PER_RUN,
): Promise<number> {
  const pending = await deps.store.pendingAnswers(limit);
  const byRepo = new Map<string, PendingAnswer[]>();
  for (const answer of pending) {
    const key = `${answer.installationId}:${answer.repo.toLowerCase()}`;
    byRepo.set(key, [...(byRepo.get(key) ?? []), answer]);
  }
  let read = 0;
  for (const answers of byRepo.values()) {
    const [first] = answers;
    if (first === undefined) continue;
    try {
      await deps.rejected(
        first.installationId,
        first.repo,
        answers.map((answer) => ({ findingId: answer.findingId })),
      );
      await deps.store.answersLearned(answers.map((answer) => answer.eventId));
      read += answers.length;
    } catch (error) {
      deps.log("answers not learned from", {
        repo: first.repo,
        count: answers.length,
        error: error instanceof Error ? error.message : String(error),
      });
      const given = await deps.store.answersFailed(
        answers.map((answer) => answer.eventId),
        MAX_ANSWER_ATTEMPTS,
      );
      if (given.length > 0) {
        deps.log("answers given up on: outcome learning kept failing", {
          repo: first.repo,
          count: given.length,
          attempts: MAX_ANSWER_ATTEMPTS,
        });
      }
    }
  }
  return read;
}
