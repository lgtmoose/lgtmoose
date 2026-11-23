/** Pure helpers for the dashboard pages: routes, labels and numbers. No DOM. */

export type Route =
  | { page: "repos" }
  /** `pr` only with `repo`: one pull request's findings (NIC-1142). */
  | { page: "findings"; repo: string | undefined; pr?: number | undefined }
  | { page: "runs"; repo: string | undefined }
  | { page: "learnings"; status: LearningStatus }
  | { page: "usage" }
  | { page: "acceptance" }
  | { page: "bootstrap" }
  | { page: "signed-out"; error: string | undefined };

export type LearningStatus = "pending" | "active" | "retired";
export const LEARNING_STATUSES: readonly LearningStatus[] = ["pending", "active", "retired"];

function learningStatus(value: string | null): LearningStatus {
  return (LEARNING_STATUSES as readonly (string | null)[]).includes(value)
    ? (value as LearningStatus)
    : "pending";
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The largest pull request number the API takes: Postgres's `int4`, as the server checks. */
export const MAX_PR_NUMBER = 2_147_483_647;

/** A pull request number from the location: digits only, from 1 to `MAX_PR_NUMBER`. */
function pullNumber(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  const number = Number(value);
  return number <= MAX_PR_NUMBER ? number : undefined;
}

/** The page a location hash names, such as `#/findings?repo=acme/api`. Anything else: repos. */
export function parseRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?", 2);
  const params = new URLSearchParams(search);
  const repoParam = params.get("repo") ?? undefined;
  const repo = repoParam !== undefined && REPO.test(repoParam) ? repoParam : undefined;
  switch (path) {
    case "/findings": {
      const pr = repo === undefined ? undefined : pullNumber(params.get("pr"));
      return pr === undefined ? { page: "findings", repo } : { page: "findings", repo, pr };
    }
    case "/runs":
      return { page: "runs", repo };
    case "/learnings":
      return { page: "learnings", status: learningStatus(params.get("status")) };
    case "/usage":
      return { page: "usage" };
    case "/acceptance":
      return { page: "acceptance" };
    case "/bootstrap":
      return { page: "bootstrap" };
    case "/signed-out":
      return { page: "signed-out", error: params.get("error") ?? undefined };
    default:
      return { page: "repos" };
  }
}

export function routeHash(route: Route): string {
  if (route.page === "repos") return "#/";
  if (route.page === "signed-out") return "#/signed-out";
  if (route.page === "usage" || route.page === "acceptance" || route.page === "bootstrap") {
    return `#/${route.page}`;
  }
  if (route.page === "learnings") {
    return route.status === "pending" ? "#/learnings" : `#/learnings?status=${route.status}`;
  }
  if (route.repo === undefined) return `#/${route.page}`;
  const repo = `#/${route.page}?repo=${encodeURIComponent(route.repo)}`;
  return route.page === "findings" && route.pr !== undefined ? `${repo}&pr=${route.pr}` : repo;
}

/** The findings API's query for a page: all, one repository's, or one pull request's. */
export function findingsQuery(repo: string | undefined, pr: number | undefined): string {
  if (repo === undefined) return "";
  const query = `?repo=${encodeURIComponent(repo)}`;
  return pr === undefined ? query : `${query}&pr=${pr}`;
}

/** What a finding's answer is, if it has one, such as "Fixed: waiting for recheck by octocat". */
export function answerState(finding: {
  fixClaimedAt?: string | undefined;
  fixClaimedBy?: string | undefined;
}): string | undefined {
  if (finding.fixClaimedAt === undefined) return undefined;
  return finding.fixClaimedBy === undefined
    ? "Fixed: waiting for recheck"
    : `Fixed: waiting for recheck by ${finding.fixClaimedBy}`;
}

/** The longest decline reason the API keeps (`MAX_DECLINE_REASON` in @lgtmoose/core). */
export const DECLINE_REASON_LIMIT = 2000;

/** Why a decline reason can't be sent as it is, or undefined when it can. */
export function declineReasonProblem(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "A decline needs a reason.";
  if (trimmed.length > DECLINE_REASON_LIMIT) {
    return `The reason is ${trimmed.length} characters; at most ${DECLINE_REASON_LIMIT}.`;
  }
  if (trimmed.includes("\u0000")) return "The reason can't contain a NUL character.";
  return undefined;
}

/** Why the API refused an answer to a finding, in words for the page. */
export function answerRefusal(status: number, error: string | undefined): string {
  const said = error === undefined ? "" : `: ${error}`;
  switch (status) {
    case 400:
      return `The answer wasn't accepted${said}.`;
    case 403:
      return error ?? "You can't answer this finding.";
    case 404:
      return "That finding isn't there any more, or isn't yours to see.";
    case 409:
      return error ?? "That finding can't take this answer now.";
    case 503:
      return "GitHub couldn't be asked just now. Try again in a moment.";
    default:
      return `The dashboard API answered ${status}${said}.`;
  }
}

/** What the sign-in page says for the API's error codes; unknown codes get a generic line. */
export function signInMessage(error: string | undefined): string | undefined {
  switch (error) {
    case undefined:
      return undefined;
    case "denied":
      return "Sign-in was cancelled on GitHub.";
    case "expired":
      return "The sign-in took too long or didn't match. Try again.";
    case "not-member":
      return "Your GitHub account isn't a member of an organization this LGTMoose reviews for.";
    case "not-configured":
      return "The dashboard's GitHub sign-in isn't set up yet. Run lgtmoose deploy again, then add the callback URL to the GitHub App.";
    default:
      return "Sign-in failed. Try again in a moment.";
  }
}

export const SEVERITY_LABELS: Record<string, string> = {
  blocking: "Blocking",
  should_fix: "Should fix",
  nit: "Nit",
};

export function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity] ?? severity;
}

export function money(usd: number | undefined): string {
  return usd === undefined ? "—" : `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

/** A share such as 0.625 as `63%`; "—" without one. */
export function percent(share: number | undefined): string {
  return share === undefined || !Number.isFinite(share) ? "—" : `${Math.round(share * 100)}%`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/** Why the API refused to change a learning, in words for the page. */
export function learningRefusal(status: number, reason: string | undefined): string {
  if (status === 403) return reason ?? "You can't change this learning.";
  if (status === 404) return "That learning isn't there any more, or isn't yours to see.";
  return `The dashboard API answered ${status}.`;
}

/** A timestamp as the browser's local date and time; "—" without one. */
export function when(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** How long a run took, such as `3m 20s`; "—" until it finished. */
export function duration(startedAt: string | undefined, finishedAt: string | undefined): string {
  if (startedAt === undefined || finishedAt === undefined) return "—";
  const seconds = Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

/** The PR's page on GitHub: built from parts already validated, never from free text. */
/**
 * A review comment's URL on github.com, built from its repository, PR and ID (never a URL from
 * the API): an inline comment's discussion, or a submitted review.
 */
export function reviewCommentUrl(
  repo: string,
  number: number,
  commentId: number,
  inline: boolean,
): string | undefined {
  const pull = pullRequestUrl(repo, number);
  if (pull === undefined || !Number.isSafeInteger(commentId) || commentId <= 0) return undefined;
  return `${pull}#${inline ? "discussion_r" : "pullrequestreview-"}${commentId}`;
}

export function pullRequestUrl(repo: string, number: number): string | undefined {
  if (!REPO.test(repo) || !Number.isSafeInteger(number) || number <= 0) return undefined;
  return `https://github.com/${repo}/pull/${number}`;
}
