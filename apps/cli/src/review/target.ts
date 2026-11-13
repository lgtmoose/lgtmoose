import type { PullTarget } from "@lgtmoose/pipeline";

export type { PullTarget };

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * Reads `owner/repo#123` or a PR URL (`https://github.com/owner/repo/pull/123`). Returns
 * undefined for anything else, so the command can say what it expects.
 */
export function parseTarget(text: string): PullTarget | undefined {
  const short = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(text);
  const url = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(text);
  const [, owner, repo, number] = short ?? url ?? [];
  if (owner === undefined || repo === undefined || number === undefined) return undefined;
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return undefined;
  const parsed = Number(number);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return { owner, repo, number: parsed };
}

export function targetText(target: PullTarget): string {
  return `${target.owner}/${target.repo}#${target.number}`;
}
