import { el, replace, table } from "./dom.js";
import {
  duration,
  money,
  parseRoute,
  pullRequestUrl,
  routeHash,
  severityLabel,
  signInMessage,
  when,
  type Route,
} from "./format.js";

/**
 * The dashboard (NIC-840): open findings and review runs for the repositories the signed-in
 * person can see. Every call goes to /api on this same origin; the session is an HttpOnly cookie
 * this script never sees.
 */

interface Me {
  login: string;
  orgs: string[];
  repos: number;
  expiresAt: string;
}

interface RepoSummary {
  repo: string;
  openFindings: number;
  blocking: number;
  lastRunAt: string | undefined;
}

interface Finding {
  id: string;
  repo: string;
  number: number;
  severity: string;
  ruleCategory: string;
  title: string;
  body: string;
  path: string | undefined;
  line: number | undefined;
  source: string;
  sourceLogin: string | undefined;
}

interface Run {
  id: string;
  repo: string;
  number: number;
  headSha: string;
  kind: string;
  status: string;
  costUsd: number | undefined;
  filesDone: number;
  filesTotal: number | undefined;
  providers: string[];
  startedAt: string | undefined;
  finishedAt: string | undefined;
  createdAt: string;
}

class SignedOut extends Error {}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (response.status === 401) throw new SignedOut();
  if (!response.ok) throw new Error(`The dashboard API answered ${response.status}.`);
  return (await response.json()) as T;
}

const main = () => document.getElementById("main") as HTMLElement;

function link(route: Route, text: string): HTMLAnchorElement {
  return el("a", { href: routeHash(route) }, text);
}

function prLink(repo: string, number: number): Node {
  const url = pullRequestUrl(repo, number);
  return url === undefined
    ? document.createTextNode(`#${number}`)
    : el("a", { href: url, rel: "noopener noreferrer" }, `${repo}#${number}`);
}

function renderNav(me: Me | undefined): void {
  const nav = document.getElementById("nav") as HTMLElement;
  const account = document.getElementById("account") as HTMLElement;
  if (me === undefined) {
    replace(nav);
    replace(account);
    return;
  }
  replace(
    nav,
    link({ page: "repos" }, "Repositories"),
    link({ page: "findings", repo: undefined }, "Open findings"),
    link({ page: "runs", repo: undefined }, "Review runs"),
  );
  const signOut = el("button", { type: "button" }, "Sign out");
  signOut.addEventListener("click", () => {
    void fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).finally(() => {
      window.location.hash = "#/signed-out";
      window.location.reload();
    });
  });
  replace(account, el("span", { class: "muted" }, `${me.login} `), signOut);
}

function renderSignIn(error: string | undefined): void {
  const message = signInMessage(error);
  replace(
    main(),
    el("h1", {}, "LGTMoose"),
    message === undefined ? undefined : el("p", { role: "alert" }, message),
    el("p", {}, el("a", { href: "/api/auth/login" }, "Sign in with GitHub")),
    el(
      "p",
      { class: "muted" },
      "Only members of the organizations this LGTMoose reviews for can sign in. You see the repositories you can see on GitHub.",
    ),
  );
}

async function renderRepos(): Promise<void> {
  const { repos } = await api<{ repos: RepoSummary[] }>("/api/repos");
  replace(
    main(),
    el("h1", {}, "Repositories"),
    repos.length === 0
      ? el("p", { class: "muted" }, "No reviews yet in the repositories you can see.")
      : table(
          ["Repository", "Open findings", "Blocking", "Last review", ""],
          repos.map((repo) => [
            repo.repo,
            el("span", { class: "num" }, String(repo.openFindings)),
            el("span", { class: repo.blocking > 0 ? "sev-blocking" : "" }, String(repo.blocking)),
            when(repo.lastRunAt),
            el(
              "span",
              {},
              link({ page: "findings", repo: repo.repo }, "Findings"),
              " · ",
              link({ page: "runs", repo: repo.repo }, "Runs"),
            ),
          ]),
        ),
  );
}

function repoQuery(repo: string | undefined): string {
  return repo === undefined ? "" : `?repo=${encodeURIComponent(repo)}`;
}

async function renderFindings(repo: string | undefined): Promise<void> {
  const { findings } = await api<{ findings: Finding[] }>(`/api/findings${repoQuery(repo)}`);
  replace(
    main(),
    el("h1", {}, repo === undefined ? "Open findings" : `Open findings in ${repo}`),
    findings.length === 0
      ? el("p", { class: "muted" }, "No open findings.")
      : table(
          ["Severity", "Pull request", "Where", "Finding", "Raised by"],
          findings.map((finding) => [
            el("span", { class: `sev-${finding.severity}` }, severityLabel(finding.severity)),
            prLink(finding.repo, finding.number),
            finding.path === undefined
              ? "—"
              : `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`,
            el(
              "div",
              {},
              el("strong", {}, finding.title),
              el("span", { class: "muted" }, ` (${finding.ruleCategory})`),
              el("pre", { class: "body" }, finding.body),
            ),
            finding.source === "self" ? "LGTMoose" : (finding.sourceLogin ?? finding.source),
          ]),
        ),
  );
}

async function renderRuns(repo: string | undefined): Promise<void> {
  const { runs } = await api<{ runs: Run[] }>(`/api/runs${repoQuery(repo)}`);
  replace(
    main(),
    el("h1", {}, repo === undefined ? "Review runs" : `Review runs in ${repo}`),
    runs.length === 0
      ? el("p", { class: "muted" }, "No review runs yet.")
      : table(
          ["Started", "Pull request", "Kind", "Status", "Files", "Took", "Cost", "Providers"],
          runs.map((run) => [
            when(run.startedAt ?? run.createdAt),
            prLink(run.repo, run.number),
            run.kind,
            run.status,
            run.filesTotal === undefined ? String(run.filesDone) : `${run.filesDone}/${run.filesTotal}`,
            duration(run.startedAt, run.finishedAt),
            money(run.costUsd),
            run.providers.length === 0 ? "—" : run.providers.join(", "),
          ]),
        ),
  );
}

async function render(): Promise<void> {
  const route = parseRoute(window.location.hash);
  if (route.page === "signed-out") {
    renderNav(undefined);
    renderSignIn(route.error);
    return;
  }
  try {
    const me = await api<Me>("/api/me");
    renderNav(me);
    if (route.page === "findings") await renderFindings(route.repo);
    else if (route.page === "runs") await renderRuns(route.repo);
    else await renderRepos();
  } catch (error) {
    if (error instanceof SignedOut) {
      renderNav(undefined);
      renderSignIn(undefined);
      return;
    }
    replace(main(), el("p", { role: "alert" }, error instanceof Error ? error.message : "Something went wrong."));
  }
}

window.addEventListener("hashchange", () => void render());
void render();
