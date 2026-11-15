/** Pure helpers for the dashboard pages: routes, labels and numbers. No DOM. */

export type Route =
  | { page: "repos" }
  | { page: "findings"; repo: string | undefined }
  | { page: "runs"; repo: string | undefined }
  | { page: "learnings"; status: LearningStatus }
  | { page: "usage" }
  | { page: "acceptance" }
  | { page: "signed-out"; error: string | undefined };

export type LearningStatus = "pending" | "active" | "retired";
export const LEARNING_STATUSES: readonly LearningStatus[] = ["pending", "active", "retired"];

function learningStatus(value: string | null): LearningStatus {
  return (LEARNING_STATUSES as readonly (string | null)[]).includes(value)
    ? (value as LearningStatus)
    : "pending";
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The page a location hash names, such as `#/findings?repo=acme/api`. Anything else: repos. */
export function parseRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?", 2);
  const params = new URLSearchParams(search);
  const repoParam = params.get("repo") ?? undefined;
  const repo = repoParam !== undefined && REPO.test(repoParam) ? repoParam : undefined;
  switch (path) {
    case "/findings":
      return { page: "findings", repo };
    case "/runs":
      return { page: "runs", repo };
    case "/learnings":
      return { page: "learnings", status: learningStatus(params.get("status")) };
    case "/usage":
      return { page: "usage" };
    case "/acceptance":
      return { page: "acceptance" };
    case "/signed-out":
      return { page: "signed-out", error: params.get("error") ?? undefined };
    default:
      return { page: "repos" };
  }
}

export function routeHash(route: Route): string {
  if (route.page === "repos") return "#/";
  if (route.page === "signed-out") return "#/signed-out";
  if (route.page === "usage" || route.page === "acceptance") return `#/${route.page}`;
  if (route.page === "learnings") {
    return route.status === "pending" ? "#/learnings" : `#/learnings?status=${route.status}`;
  }
  return route.repo === undefined
    ? `#/${route.page}`
    : `#/${route.page}?repo=${encodeURIComponent(route.repo)}`;
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
export function pullRequestUrl(repo: string, number: number): string | undefined {
  if (!REPO.test(repo) || !Number.isSafeInteger(number) || number <= 0) return undefined;
  return `https://github.com/${repo}/pull/${number}`;
}
