import { z } from "zod";
import { findTicketKeys, type FindOptions } from "./find.js";
import { TicketProviderError, type Ticket, type TicketProvider } from "./ticket.js";

/**
 * The Linear provider: read-only, through Linear's GraphQL API with an API key that
 * `lgtmoose auth linear` stores in Secrets Manager. It only runs queries; it has no mutation
 * and never changes a ticket. The key is sent in the `Authorization` header and nowhere else,
 * and no error message holds it.
 */

export const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Text kept from a ticket: enough for a checklist, capped so a huge ticket can't fill a prompt. */
export const LINEAR_LIMITS = {
  title: 300,
  description: 20_000,
  relatedDescription: 4_000,
  comment: 4_000,
  comments: 30,
  children: 25,
} as const;

const TIMEOUT_MS = 15_000;

const QUERY = `query LgtmooseTicket($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
    updatedAt
    state { name }
    parent { identifier title description state { name } }
    children(first: ${LINEAR_LIMITS.children}) { nodes { identifier title state { name } } }
    comments(first: ${LINEAR_LIMITS.comments}) { nodes { body createdAt user { name } } }
  }
}`;

const state = z.object({ name: z.string() }).nullish();

const issueSchema = z.object({
  identifier: z.string().min(1),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string(),
  updatedAt: z.string(),
  state,
  parent: z
    .object({
      identifier: z.string(),
      title: z.string(),
      description: z.string().nullish(),
      state,
    })
    .nullish(),
  children: z
    .object({ nodes: z.array(z.object({ identifier: z.string(), title: z.string(), state })) })
    .nullish(),
  comments: z
    .object({
      nodes: z.array(
        z.object({
          body: z.string(),
          createdAt: z.string(),
          user: z.object({ name: z.string() }).nullish(),
        }),
      ),
    })
    .nullish(),
});

const replySchema = z.object({
  data: z.object({ issue: issueSchema.nullish() }).nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export interface LinearOptions {
  /** A Linear API key with read access. Never logged. */
  apiKey: string;
  fetch?: typeof fetch;
  /** Only these teams' keys count (see `findTicketKeys`). */
  teamKeys?: readonly string[];
  /** For tests. */
  url?: string;
}

function clip(text: string | null | undefined, max: number): string {
  const value = text ?? "";
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** An error message from Linear, clipped: it describes the request, never the key. */
function clipMessage(text: string): string {
  return clip(text.replace(/\s+/g, " "), 200);
}

function toTicket(issue: z.infer<typeof issueSchema>): Ticket {
  return {
    key: issue.identifier,
    title: clip(issue.title, LINEAR_LIMITS.title),
    description: clip(issue.description, LINEAR_LIMITS.description),
    url: issue.url,
    updatedAt: issue.updatedAt,
    ...(issue.state?.name === undefined ? {} : { state: issue.state.name }),
    comments: (issue.comments?.nodes ?? []).slice(0, LINEAR_LIMITS.comments).map((comment) => ({
      author: comment.user?.name ?? "unknown",
      body: clip(comment.body, LINEAR_LIMITS.comment),
      createdAt: comment.createdAt,
    })),
    ...(issue.parent === null || issue.parent === undefined
      ? {}
      : {
          parent: {
            key: issue.parent.identifier,
            title: clip(issue.parent.title, LINEAR_LIMITS.title),
            description: clip(issue.parent.description, LINEAR_LIMITS.relatedDescription),
            ...(issue.parent.state?.name === undefined ? {} : { state: issue.parent.state.name }),
          },
        }),
    children: (issue.children?.nodes ?? []).slice(0, LINEAR_LIMITS.children).map((child) => ({
      key: child.identifier,
      title: clip(child.title, LINEAR_LIMITS.title),
      ...(child.state?.name === undefined ? {} : { state: child.state.name }),
    })),
  };
}

/** Linear's answer for an identifier it has no issue for. */
function notFound(errors: readonly { message: string }[]): boolean {
  return errors.some((error) => /not found/i.test(error.message));
}

/** A read-only Linear ticket provider. */
export function linearProvider(options: LinearOptions): TicketProvider {
  const apiKey = options.apiKey.trim();
  if (apiKey === "") throw new TicketProviderError("The Linear API key is empty.");
  const fetchFn = options.fetch ?? fetch;
  const url = options.url ?? LINEAR_API_URL;
  const find: FindOptions = options.teamKeys === undefined ? {} : { teamKeys: options.teamKeys };
  return {
    name: "Linear",
    find: (texts) => findTicketKeys(texts, find),
    async fetch(key) {
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: apiKey },
          body: JSON.stringify({ query: QUERY, variables: { id: key } }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new TicketProviderError(
          `Linear couldn't be reached: ${error instanceof Error ? error.name : "error"}.`,
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new TicketProviderError(
          `Linear refused the API key (HTTP ${response.status}); run lgtmoose auth linear again.`,
        );
      }
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new TicketProviderError(`Linear's reply isn't JSON (HTTP ${response.status}).`);
      }
      const parsed = replySchema.safeParse(json);
      if (!parsed.success) {
        throw new TicketProviderError(
          `Linear's reply isn't the expected shape (HTTP ${response.status}).`,
        );
      }
      const { data, errors = [] } = parsed.data;
      if (errors.length > 0) {
        if (notFound(errors)) return undefined;
        throw new TicketProviderError(
          `Linear answered with an error: ${clipMessage(errors[0]?.message ?? "")}`,
        );
      }
      if (!response.ok) throw new TicketProviderError(`Linear answered HTTP ${response.status}.`);
      const issue = data?.issue;
      return issue === null || issue === undefined ? undefined : toTicket(issue);
    },
  };
}
