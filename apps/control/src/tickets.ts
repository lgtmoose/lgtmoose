import { ticketCoverageSchema, type TicketCoverageResult } from "@lgtmoose/core";
import type { Repo } from "@lgtmoose/git";
import {
  batchOutputSchema,
  headKeys,
  runKeys,
  scanText,
  type InjectionKind,
  type PreparedReview,
  type TicketReview,
} from "@lgtmoose/pipeline";
import { buildTicketCoveragePrompt } from "@lgtmoose/roles";
import {
  TicketProviderError,
  findTicketKeys,
  linearProvider,
  type Ticket,
  type TicketProvider,
} from "@lgtmoose/tickets";
import { z } from "zod";
import type { TicketSettings } from "./env.js";
import type { ArtifactStore, ControlDeps } from "./ports.js";

/**
 * `ControlDeps.tickets` from the settings. The provider's API key is read from its secret the
 * first time a ticket is fetched, not at start-up: a missing or unreadable key fails only ticket
 * coverage (each ticket is noted as unread), never the review.
 */
export function ticketSourceFor(
  settings: TicketSettings,
  secret: (arn: string) => Promise<string>,
  fetchFn: typeof fetch = fetch,
): ControlDeps["tickets"] {
  if (settings.provider === "none") return undefined;
  let provider: Promise<TicketProvider> | undefined;
  const linear = () =>
    (provider ??= secret(settings.secretArn).then(
      (apiKey) => linearProvider({ apiKey, fetch: fetchFn, teamKeys: settings.teamKeys }),
      () => {
        // The secret's own error can name it; say only that it couldn't be read.
        throw new TicketProviderError(
          "The Linear API key couldn't be read; run lgtmoose auth linear.",
        );
      },
    ));
  return {
    maxPerPullRequest: settings.maxPerPullRequest,
    detailsOnPublicRepos: settings.detailsOnPublicRepos,
    provider: {
      name: "Linear",
      find: (texts) => findTicketKeys(texts, { teamKeys: settings.teamKeys }),
      fetch: async (key) => (await linear()).fetch(key),
    },
  };
}

/**
 * Ticket coverage in the review workflow (NIC-839).
 *
 * - **Prepare** (`prepareTickets`), in the control task: finds the ticket keys the PR names,
 *   reads each ticket from the provider with the provider's credential (which only the control
 *   task holds), scans its text with the prompt-injection detector, and adds a ticket checker
 *   batch per ticket with its text in the prompt. A checklist an earlier run at this head made
 *   from the same version of the ticket (its `updatedAt`) is reused instead.
 * - **The sandbox** runs the checker on the fast tier, with the checkout and no ticket-system
 *   credential, and writes a checklist (`ticketCoverageSchema`).
 * - **Post** (`ticketReview`) reads the checklists, keeps each for later runs at this head, and
 *   hands them to `finishReview`, which shows the table and counts missing core requirements
 *   as should-fix findings, capped.
 */

/** The longest a ticket checker run may take: it reads one ticket and the PR's change. */
export const TICKET_TIMEOUT_MS = 5 * 60_000;

/** At most this many commit messages are read for ticket keys. */
const COMMIT_LIMIT = 100;

/** One linked ticket in a run, as the prepare step wrote it (trusted: not model output). */
export interface TicketJob {
  key: string;
  title: string;
  url?: string;
  updatedAt?: string;
  /** Its checker batch in this run. Left out when it's reused or wasn't read. */
  index?: number;
  /** A checklist from an earlier run at this head, for this version of the ticket. */
  coverage?: TicketCoverageResult;
  /** Why it has no checklist (it couldn't be read). Plain code text. */
  note?: string;
  /** What the prompt-injection detector flagged in its text. */
  injected?: InjectionKind[];
}

/** What a run's manifest records about its tickets. */
export interface TicketsManifest {
  provider: string;
  tickets: TicketJob[];
  /**
   * Whether the summary may show ticket text (`TicketReview.details`): on a private repository,
   * or with `tickets.detailsOnPublicRepos`. Decided at prepare, from GitHub's facts.
   */
  details: boolean;
  /** Why no tickets were read (`TicketReview.notice`). */
  notice?: string;
}

/**
 * Authors whose PRs get ticket coverage (`author_association`). Anyone who can open a PR picks
 * which ticket keys it names, so on a public repository an outside contributor could make
 * LGTMoose read private tickets and describe them in a public comment. Their PRs aren't
 * checked against tickets at all.
 */
const TICKET_AUTHORS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Said instead of the table on another author's PR. Names no keys. */
export const OUTSIDE_AUTHOR_NOTICE =
  "Ticket coverage runs only for pull requests by the repository's owners, members and collaborators.";

const cachedSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  coverage: ticketCoverageSchema,
});

/** The PR's commit messages, oldest first. Empty when git can't list them. */
async function commitMessages(repo: Repo, from: string, to: string): Promise<string[]> {
  try {
    const out = await repo.git([
      "log",
      "--reverse",
      `--max-count=${COMMIT_LIMIT}`,
      "--format=%B%x1e",
      `${from}..${to}`,
    ]);
    return out
      .split("\x1e")
      .map((message) => message.trim())
      .filter((message) => message !== "");
  } catch {
    return [];
  }
}

/** Everything in a ticket a model reads, for the prompt-injection detector. */
function ticketTexts(ticket: Ticket): string[] {
  return [
    ticket.title,
    ticket.description,
    ...ticket.comments.map((comment) => comment.body),
    ...(ticket.parent === undefined ? [] : [ticket.parent.title, ticket.parent.description ?? ""]),
    ...ticket.children.map((child) => child.title),
  ];
}

function injectedKinds(ticket: Ticket): InjectionKind[] {
  const kinds = new Set<InjectionKind>();
  for (const text of ticketTexts(ticket)) {
    for (const kind of scanText(text, { markdown: true })) kinds.add(kind);
  }
  return [...kinds];
}

async function cachedCoverage(
  store: ArtifactStore,
  key: string,
  updatedAt: string,
): Promise<TicketCoverageResult | undefined> {
  const text = await store.getText(key);
  if (text === undefined) return undefined;
  try {
    const parsed = cachedSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.updatedAt === updatedAt ? parsed.data.coverage : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The PR's linked tickets for this run, with a checker batch (index and prompt) for each ticket
 * not checked at this head yet. Nothing when no provider is configured or the PR names none.
 */
export async function prepareTickets(
  deps: {
    tickets?: {
      provider: TicketProvider;
      maxPerPullRequest: number;
      detailsOnPublicRepos?: boolean;
    };
    store: ArtifactStore;
    log(message: string, fields?: Record<string, unknown>): void;
  },
  repo: Repo,
  prepared: PreparedReview,
  firstIndex: number,
): Promise<{ manifest?: TicketsManifest; batches: { index: number; prompt: string }[] }> {
  const settings = deps.tickets;
  if (settings === undefined || settings.maxPerPullRequest <= 0) return { batches: [] };
  const { pr, target } = prepared;
  const refs = settings.provider
    .find({
      branch: pr.headRef,
      title: pr.title,
      body: pr.body,
      commits: await commitMessages(repo, prepared.mergeBase, pr.headSha),
    })
    .slice(0, settings.maxPerPullRequest);
  if (refs.length === 0) return { batches: [] };
  // Text the summary may show: all of it on a private repository, only keys and counts on a
  // public one (or one whose visibility GitHub didn't give) unless the operator opts in.
  const details = pr.repoPrivate === true || settings.detailsOnPublicRepos === true;
  // Whoever opens a PR picks the keys it names: only members' PRs get tickets read at all.
  if (!TICKET_AUTHORS.has(pr.association ?? "")) {
    deps.log("tickets skipped: the PR's author isn't a member", {
      association: pr.association ?? "unknown",
    });
    return {
      manifest: {
        provider: settings.provider.name,
        tickets: [],
        details,
        notice: OUTSIDE_AUTHOR_NOTICE,
      },
      batches: [],
    };
  }
  const keys = headKeys(`${target.owner}/${target.repo}`, target.number, pr.headSha);
  const files = prepared.files.map((file) => ({ path: file.path, status: file.status }));
  const jobs: TicketJob[] = [];
  const batches: { index: number; prompt: string }[] = [];
  for (const ref of refs) {
    let ticket: Ticket | undefined;
    try {
      ticket = await settings.provider.fetch(ref.key);
    } catch (error) {
      deps.log("ticket unread", { key: ref.key, error: errorMessage(error) });
      jobs.push({
        key: ref.key,
        title: "",
        note: `couldn't be read from ${settings.provider.name}`,
      });
      continue;
    }
    // A key the provider doesn't know isn't a ticket (`ENG-1` in prose, say): left out.
    if (ticket === undefined) continue;
    const injected = injectedKinds(ticket);
    const job: TicketJob = {
      key: ticket.key,
      title: ticket.title,
      url: ticket.url,
      updatedAt: ticket.updatedAt,
      ...(injected.length === 0 ? {} : { injected }),
    };
    let cacheKey: string | undefined;
    try {
      cacheKey = keys.ticketCoverage(ticket.key);
    } catch {
      cacheKey = undefined;
    }
    const cached =
      cacheKey === undefined
        ? undefined
        : await cachedCoverage(deps.store, cacheKey, ticket.updatedAt);
    if (cached !== undefined) {
      jobs.push({ ...job, coverage: cached });
      continue;
    }
    const index = firstIndex + batches.length;
    batches.push({
      index,
      prompt: buildTicketCoveragePrompt({
        ticket,
        prTitle: pr.title,
        mergeBase: prepared.mergeBase,
        headSha: pr.headSha,
        files,
      }),
    });
    jobs.push({ ...job, index });
  }
  if (jobs.length === 0) return { batches: [] };
  deps.log("tickets linked", {
    tickets: jobs.length,
    checking: batches.length,
    reused: jobs.filter((job) => job.coverage !== undefined).length,
    flagged: jobs.filter((job) => job.injected !== undefined).length,
  });
  return { manifest: { provider: settings.provider.name, tickets: jobs, details }, batches };
}

/**
 * A ticket batch's checklist from its output object: undefined when there's no output, it
 * failed, or it doesn't validate. The sandbox ran a model on ticket text and code, so it's
 * checked like any model output.
 */
export async function readCoverage(
  store: ArtifactStore,
  runId: string,
  index: number,
): Promise<TicketCoverageResult | undefined> {
  const text = await store.getText(runKeys(runId).batchOutput(index));
  if (text === undefined) return undefined;
  try {
    const parsed = batchOutputSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.index === index ? parsed.data.coverage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run's ticket review for `finishReview`: each linked ticket with its checklist (this run's,
 * or one reused from an earlier run at this head). A checklist made this run is kept for later
 * runs at this head, until the ticket changes.
 */
export async function ticketReview(
  store: ArtifactStore,
  runId: string,
  prepared: PreparedReview,
  manifest: TicketsManifest,
): Promise<TicketReview> {
  const { target, pr } = prepared;
  const keys = headKeys(`${target.owner}/${target.repo}`, target.number, pr.headSha);
  const tickets: TicketReview["tickets"] = [];
  for (const job of manifest.tickets) {
    let coverage = job.coverage;
    let note = job.note;
    if (coverage === undefined && job.index !== undefined) {
      coverage = await readCoverage(store, runId, job.index);
      if (coverage === undefined) {
        note = "the check didn't finish";
      } else if (job.updatedAt !== undefined) {
        try {
          await store.putText(
            keys.ticketCoverage(job.key),
            JSON.stringify({ version: 1, updatedAt: job.updatedAt, coverage }),
          );
        } catch {
          // Not kept: the next run at this head checks the ticket again.
        }
      }
    }
    tickets.push({
      key: job.key,
      title: job.title,
      ...(job.url === undefined ? {} : { url: job.url }),
      ...(coverage === undefined ? {} : { coverage }),
      ...(note === undefined ? {} : { note }),
    });
  }
  return {
    provider: manifest.provider,
    tickets,
    injected: manifest.tickets.flatMap((job) =>
      job.injected === undefined ? [] : [{ key: job.key, kinds: job.injected }],
    ),
    // A manifest written without it can't say the repository is private: keys and counts only.
    details: manifest.details === true,
    ...(manifest.notice === undefined ? {} : { notice: manifest.notice }),
  };
}
