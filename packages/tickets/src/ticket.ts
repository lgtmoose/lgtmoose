/**
 * Tickets, as a ticket provider gives them, for ticket coverage (NIC-839): the review reads the
 * tickets a pull request names and checks the PR against their requirements.
 *
 * Everything in a ticket was written by whoever can edit it, so it's untrusted text, like the
 * PR's own description: it's scanned by the prompt-injection detector and wrapped in untrusted
 * blocks before a model reads it.
 */

/** Where in a pull request a ticket key was found. */
export type TicketSource = "branch" | "title" | "body" | "commit";

/** A ticket key a pull request names, such as `ENG-123`, and where it was found first. */
export interface TicketRef {
  key: string;
  source: TicketSource;
}

/** A ticket related to the one fetched: its parent, or one of its sub-issues. */
export interface RelatedTicket {
  key: string;
  title: string;
  /** Its description, for a parent; left out for sub-issues. */
  description?: string;
  /** Its workflow state's name, such as "In Progress". */
  state?: string;
}

export interface TicketComment {
  /** The author's display name, as the provider gives it. */
  author: string;
  body: string;
  createdAt: string;
}

/** One ticket, with what a requirements checklist needs from it. Text is capped. */
export interface Ticket {
  key: string;
  title: string;
  description: string;
  url: string;
  /** When the ticket last changed: a checklist made from it is reused until this moves. */
  updatedAt: string;
  state?: string;
  comments: TicketComment[];
  parent?: RelatedTicket;
  children: RelatedTicket[];
}

/** The parts of a pull request that can name a ticket. */
export interface TicketTexts {
  /** The head branch's name, such as `alice/eng-123-fix-totals`. */
  branch: string;
  title: string;
  body: string;
  /** The PR's commit messages, oldest first. */
  commits: readonly string[];
}

/**
 * A ticket provider: read-only. It finds the ticket keys a pull request names and fetches each
 * ticket. It never writes to the ticket system.
 */
export interface TicketProvider {
  /** Its name for people, such as `Linear`. */
  readonly name: string;
  /** The ticket keys `texts` name, in order (branch, title, body, commits), each once. */
  find(texts: TicketTexts): TicketRef[];
  /** The ticket, or undefined when the provider has no ticket by that key. */
  fetch(key: string): Promise<Ticket | undefined>;
}

/** A provider request failed. The message never holds the credential. */
export class TicketProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketProviderError";
  }
}
