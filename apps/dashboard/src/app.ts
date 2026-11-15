import { el, replace, table } from "./dom.js";
import {
  count,
  duration,
  LEARNING_STATUSES,
  learningRefusal,
  money,
  parseRoute,
  percent,
  pullRequestUrl,
  routeHash,
  severityLabel,
  signInMessage,
  when,
  type LearningStatus,
  type Route,
} from "./format.js";

/**
 * The dashboard (NIC-840): open findings, review runs, learnings, provider usage and acceptance
 * for the repositories the signed-in person can see. Every call goes to /api on this same origin; the session is an HttpOnly cookie
 * this script never sees.
 */

interface Me {
  login: string;
  orgs: string[];
  repos: number;
  writeRepos: number;
  ownerOrgs: string[];
  expiresAt: string;
}

interface Learning {
  id: string;
  status: LearningStatus;
  kind: string;
  category: string | undefined;
  scope: string;
  org: string;
  repo: string | undefined;
  text: string;
  author: string;
  sourceRepo: string;
  sourcePr: number;
  hits: number;
  createdAt: string;
  lastUsedAt: string | undefined;
  retiredAt: string | undefined;
}

interface ProviderUse {
  providerId: string;
  batches: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  limitHits: number;
  fallbacks: number;
}

/** This month's estimated spend against the deploy config's caps (NIC-1079). */
interface Spend {
  month: string;
  caps: {
    monthlyUsd?: number;
    perRepoMonthlyUsd?: number;
    prCostPerDayUsd?: number;
    prRunsPerDay?: number;
  };
  /** Only for an owner of one of the deployment's orgs. */
  deploymentUsd?: number;
  repos: { repo: string; usd: number }[];
}

interface Cooldown {
  providerId: string;
  until: string;
  reason: string;
}

interface CategoryReport {
  category: string;
  protected: boolean;
  findings: number;
  fixed: number;
  declined: number;
  disputed: number;
  thumbsUp: number;
  thumbsDown: number;
  accepted: number;
  rejected: number;
  acceptance: number | null;
  flagged: boolean;
}

interface DeclinedFinding {
  repo: string;
  prNumber: number;
  path: string;
  line: number;
  category: string;
  severity: string;
  title: string;
}

interface FeedbackReport {
  generatedAt: string;
  windowDays: number;
  threshold: number;
  minSamples: number;
  categories: CategoryReport[];
  declined: DeclinedFinding[];
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
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) throw new SignedOut();
  if (!response.ok) throw new Error(`The dashboard API answered ${response.status}.`);
  return (await response.json()) as T;
}

/** A change the API makes: same origin, JSON, and the session cookie. */
async function post(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });
  if (response.status === 401) throw new SignedOut();
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
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
    link({ page: "learnings", status: "pending" }, "Learnings"),
    link({ page: "usage" }, "Usage"),
    link({ page: "acceptance" }, "Acceptance"),
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
            run.filesTotal === undefined
              ? String(run.filesDone)
              : `${run.filesDone}/${run.filesTotal}`,
            duration(run.startedAt, run.finishedAt),
            money(run.costUsd),
            run.providers.length === 0 ? "—" : run.providers.join(", "),
          ]),
        ),
  );
}

const STATUS_HEADINGS: Record<LearningStatus, string> = {
  pending: "Learnings waiting for approval",
  active: "Active learnings",
  retired: "Retired learnings",
};

/** Approve or reject (retire) one learning, then show the list again or say why not. */
function learningButton(
  learning: Learning,
  action: "approve" | "reject",
  status: HTMLElement,
): HTMLButtonElement {
  const button = el("button", { type: "button" }, action === "approve" ? "Approve" : "Reject");
  button.addEventListener("click", () => {
    button.disabled = true;
    void post(`/api/learnings/${encodeURIComponent(learning.id)}/${action}`)
      .then(({ status: code, body }) => {
        if (code === 200) return render();
        const reason = typeof body.error === "string" ? body.error : undefined;
        replace(status, learningRefusal(code, reason));
        button.disabled = false;
        return undefined;
      })
      .catch((error: unknown) => {
        if (error instanceof SignedOut) return render();
        replace(status, error instanceof Error ? error.message : "Something went wrong.");
        button.disabled = false;
        return undefined;
      });
  });
  return button;
}

/** What LGTMoose learned lately (NIC-1081): new learnings, and ones a decline wasn't covered by. */
function learningActivity(activity: {
  days: number;
  learned: Learning[];
  notFollowed: (Learning & { notFollowed: number })[];
}): HTMLElement[] {
  // Untrusted text: always a text node, preformatted so nothing is reflowed into markup.
  const text = (learning: Learning) => el("pre", { class: "body" }, learning.text);
  const where = (learning: Learning) => `${learning.repo ?? learning.org} (${learning.scope})`;
  return [
    el("h2", {}, `Learned in the last ${activity.days} days`),
    activity.learned.length === 0
      ? el("p", { class: "muted" }, "Nothing new.")
      : table(
          ["Learning", "Applies to", "Status", "From"],
          activity.learned.map((learning) => [
            text(learning),
            where(learning),
            learning.status,
            el(
              "span",
              {},
              `${learning.author} in `,
              prLink(learning.sourceRepo, learning.sourcePr),
            ),
          ]),
        ),
    el("h2", {}, "Learnings not followed"),
    el(
      "p",
      { class: "muted" },
      `Active learnings that were in a review's prompt, yet a finding of their category was declined anyway, in the last ${activity.days} days. Sharpen the text with a new learning, or reject one that no longer holds.`,
    ),
    activity.notFollowed.length === 0
      ? el("p", { class: "muted" }, "None.")
      : table(
          ["Learning", "Applies to", "Not followed"],
          activity.notFollowed.map((learning) => [
            text(learning),
            where(learning),
            count(learning.notFollowed),
          ]),
        ),
  ];
}

async function renderLearnings(status: LearningStatus): Promise<void> {
  const [{ learnings }, activity] = await Promise.all([
    api<{ learnings: Learning[] }>(`/api/learnings?status=${encodeURIComponent(status)}`),
    api<{ days: number; learned: Learning[]; notFollowed: (Learning & { notFollowed: number })[] }>(
      "/api/learnings/activity",
    ),
  ]);
  const tabs = el(
    "p",
    {},
    ...LEARNING_STATUSES.flatMap((each, index) => [
      index === 0 ? undefined : " · ",
      each === status ? el("strong", {}, each) : link({ page: "learnings", status: each }, each),
    ]),
  );
  replace(
    main(),
    el("h1", {}, STATUS_HEADINGS[status]),
    tabs,
    el(
      "p",
      { class: "muted" },
      "Approving needs write access to the repository, or owning the organization for an org-wide learning, as GitHub said when you signed in. Rejecting retires a learning; its history stays.",
    ),
    learnings.length === 0
      ? el("p", { class: "muted" }, "None.")
      : table(
          ["Learning", "Applies to", "Kind", "From", "Used", status === "retired" ? "Retired" : ""],
          learnings.map((learning) => {
            const message = el("span", { role: "status", class: "muted" });
            const actions =
              status === "retired"
                ? when(learning.retiredAt)
                : el(
                    "span",
                    {},
                    status === "pending" ? learningButton(learning, "approve", message) : undefined,
                    " ",
                    learningButton(learning, "reject", message),
                    " ",
                    message,
                  );
            return [
              // Untrusted: always a text node, and preformatted so nothing is reflowed into markup.
              el("pre", { class: "body" }, learning.text),
              `${learning.repo ?? learning.org} (${learning.scope})`,
              learning.category === undefined
                ? learning.kind
                : `${learning.kind}, ${learning.category}`,
              el(
                "span",
                {},
                `${learning.author} in `,
                prLink(learning.sourceRepo, learning.sourcePr),
              ),
              `${count(learning.hits)}${learning.lastUsedAt === undefined ? "" : `, last ${when(learning.lastUsedAt)}`}`,
              actions,
            ];
          }),
        ),
    ...learningActivity(activity),
  );
}

async function renderUsage(): Promise<void> {
  const { days, providers, cooldowns, spend } = await api<{
    days: number;
    providers: ProviderUse[];
    cooldowns: Cooldown[];
    spend: Spend;
  }>("/api/usage");
  replace(
    main(),
    el("h1", {}, "Provider usage"),
    el("p", { class: "muted" }, `Review batches in your repositories over the last ${days} days.`),
    providers.length === 0
      ? el("p", { class: "muted" }, "No provider use yet.")
      : table(
          [
            "Provider",
            "Batches",
            "Input tokens",
            "Output tokens",
            "Cost",
            "Limit hits",
            "Fell back",
          ],
          providers.map((use) => [
            use.providerId,
            count(use.batches),
            count(use.inputTokens),
            count(use.outputTokens),
            money(use.costUsd),
            el("span", { class: use.limitHits > 0 ? "sev-should_fix" : "" }, count(use.limitHits)),
            count(use.fallbacks),
          ]),
        ),
    ...spendSection(spend),
    el("h2", {}, "Sitting out now"),
    el(
      "p",
      { class: "muted" },
      "Providers skipped by every review after a rate limit, a used-up plan or a rejected credential.",
    ),
    cooldowns.length === 0
      ? el("p", { class: "muted" }, "None: every provider is available.")
      : table(
          ["Provider", "Until", "Why"],
          cooldowns.map((cooldown) => [cooldown.providerId, when(cooldown.until), cooldown.reason]),
        ),
  );
}

/** Spend this month against the caps: a share of a cap, or just the amount without one. */
function spendSection(spend: Spend): HTMLElement[] {
  const { caps } = spend;
  const against = (usd: number, cap: number | undefined) =>
    cap === undefined
      ? money(usd)
      : `${money(usd)} of ${money(cap)} (${percent(cap > 0 ? usd / cap : 1)})`;
  const perPr = [
    ...(caps.prCostPerDayUsd === undefined ? [] : [`${money(caps.prCostPerDayUsd)} a day`]),
    ...(caps.prRunsPerDay === undefined ? [] : [`${count(caps.prRunsPerDay)} runs a day`]),
  ];
  return [
    el("h2", {}, `Spend in ${spend.month}`),
    el(
      "p",
      { class: "muted" },
      `Estimated model cost, from each batch's tokens at its tier's price (UTC month). ${
        perPr.length === 0 ? "No per-PR cap." : `Per PR: ${perPr.join(", ")}.`
      } A repository's .lgtmoose.yaml can lower its own caps; those aren't shown.`,
    ),
    ...(spend.deploymentUsd === undefined
      ? []
      : [el("p", {}, `The whole deployment: ${against(spend.deploymentUsd, caps.monthlyUsd)}.`)]),
    spend.repos.length === 0
      ? el("p", { class: "muted" }, "No spend in your repositories this month.")
      : table(
          ["Repository", "This month"],
          spend.repos.map((entry) => [entry.repo, against(entry.usd, caps.perRepoMonthlyUsd)]),
        ),
  ];
}

async function renderAcceptance(): Promise<void> {
  const { report } = await api<{ report: FeedbackReport | null }>("/api/acceptance");
  if (report === null) {
    replace(
      main(),
      el("h1", {}, "Acceptance by rule category"),
      el("p", { class: "muted" }, "No feedback report yet. The reconciler writes one each day."),
    );
    return;
  }
  replace(
    main(),
    el("h1", {}, "Acceptance by rule category"),
    el(
      "p",
      { class: "muted" },
      `Across every repository LGTMoose reviews, findings raised in the ${report.windowDays} days to ${when(report.generatedAt)}. Flagged: below ${percent(report.threshold)} with at least ${report.minSamples} answers.`,
    ),
    report.categories.length === 0
      ? el("p", { class: "muted" }, "No findings in the window.")
      : table(
          ["Category", "Findings", "Fixed", "Declined", "Disputed", "👍 / 👎", "Acceptance", ""],
          report.categories.map((category) => [
            category.protected ? `${category.category} (protected)` : category.category,
            count(category.findings),
            count(category.fixed),
            count(category.declined),
            count(category.disputed),
            `${count(category.thumbsUp)} / ${count(category.thumbsDown)}`,
            percent(category.acceptance ?? undefined),
            category.flagged ? el("span", { class: "sev-should_fix" }, "Flagged") : "",
          ]),
        ),
    el("h2", {}, "Declined in your repositories"),
    report.declined.length === 0
      ? el("p", { class: "muted" }, "None.")
      : table(
          ["Pull request", "Where", "Category", "Severity", "Finding"],
          report.declined.map((entry) => [
            prLink(entry.repo, entry.prNumber),
            `${entry.path}:${entry.line}`,
            entry.category,
            el("span", { class: `sev-${entry.severity}` }, severityLabel(entry.severity)),
            entry.title,
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
    else if (route.page === "learnings") await renderLearnings(route.status);
    else if (route.page === "usage") await renderUsage();
    else if (route.page === "acceptance") await renderAcceptance();
    else await renderRepos();
  } catch (error) {
    if (error instanceof SignedOut) {
      renderNav(undefined);
      renderSignIn(undefined);
      return;
    }
    replace(
      main(),
      el("p", { role: "alert" }, error instanceof Error ? error.message : "Something went wrong."),
    );
  }
}

window.addEventListener("hashchange", () => void render());
void render();
