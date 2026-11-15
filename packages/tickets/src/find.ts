import type { TicketRef, TicketSource, TicketTexts } from "./ticket.js";

/**
 * Finding ticket keys such as `ENG-123` in a pull request's branch, title, body and commit
 * messages. Keys are a team key (a letter, then up to 9 letters or digits) and a number.
 *
 * - In the branch, case is ignored: tools name branches like `alice/eng-123-fix-totals`.
 * - Elsewhere, the team key must be upper case, as people write keys, so prose like `utf-8`
 *   doesn't count.
 * - With `teamKeys`, only those teams' keys count. Without them, a few prefixes that are never
 *   ticket keys (`UTF-8`, `SHA-256`, `ISO-8601`…) are left out, and a key the provider doesn't
 *   know is skipped when it's fetched.
 */

/** Prefixes that look like ticket keys but name standards or encodings. */
const NOT_TEAM_KEYS = new Set([
  "UTF",
  "SHA",
  "ISO",
  "RFC",
  "CVE",
  "CWE",
  "GHSA",
  "AES",
  "RSA",
  "HTTP",
  "TLS",
  "SSL",
  "MD",
  "ES",
  "IPV",
  "X",
  "COVID",
]);

/** The longest text read per source: a huge PR body or commit message isn't worth scanning. */
const MAX_TEXT = 20_000;

/** At most this many commit messages are read. */
const MAX_COMMITS = 100;

const KEY = /(?<![A-Za-z0-9_-])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})(?![A-Za-z0-9_])/g;

export interface FindOptions {
  /** Only these teams' keys count (upper case). Empty or left out: any team. */
  teamKeys?: readonly string[];
}

function keysIn(text: string, caseInsensitive: boolean, teams: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const match of text.slice(0, MAX_TEXT).matchAll(KEY)) {
    const [, team = "", number = ""] = match;
    if (!caseInsensitive && team !== team.toUpperCase()) continue;
    const upper = team.toUpperCase();
    if (teams.size > 0 ? !teams.has(upper) : NOT_TEAM_KEYS.has(upper)) continue;
    // A leading zero isn't a ticket number.
    if (number.startsWith("0")) continue;
    found.push(`${upper}-${number}`);
  }
  return found;
}

/** The ticket keys a pull request names, in order (branch, title, body, commits), each once. */
export function findTicketKeys(texts: TicketTexts, options: FindOptions = {}): TicketRef[] {
  const teams = new Set((options.teamKeys ?? []).map((team) => team.toUpperCase()));
  const sources: [TicketSource, string, boolean][] = [
    ["branch", texts.branch, true],
    ["title", texts.title, false],
    ["body", texts.body, false],
    ...texts.commits
      .slice(0, MAX_COMMITS)
      .map((message): [TicketSource, string, boolean] => ["commit", message, false]),
  ];
  const seen = new Set<string>();
  const refs: TicketRef[] = [];
  for (const [source, text, caseInsensitive] of sources) {
    for (const key of keysIn(text, caseInsensitive, teams)) {
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ key, source });
    }
  }
  return refs;
}
