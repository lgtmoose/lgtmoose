/**
 * Escaping for text that goes into the summary comment. PR text, findings, file paths and
 * lockfile notes are untrusted: none of it may add formatting, HTML, links, images, table cells,
 * @-mentions or issue references to the comment.
 */

/** Every ASCII punctuation character: CommonMark lets any of them be backslash-escaped. */
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

/** Word joiner: invisible, and stops GitHub from linking `@user` and `#123`. */
const JOINER = "\u2060";

/**
 * Escapes untrusted text for one line of Markdown, such as a table cell or a list item. Line
 * breaks become spaces, every ASCII punctuation mark is backslash-escaped (so `|`, `<`, `*`, `[`
 * and the rest are literal), and `@` and `#` get a word joiner after them so GitHub doesn't turn
 * them into mentions or issue links.
 */
export function inline(text: string): string {
  return text
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .trim()
    .replace(PUNCTUATION, (char) =>
      char === "@" || char === "#" ? `\\${char}${JOINER}` : `\\${char}`,
    );
}

/**
 * Escapes untrusted multi-line text as plain paragraphs. Each line is escaped like `inline`,
 * lines in a paragraph are kept apart with hard breaks, and blank lines separate paragraphs.
 */
export function paragraphs(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => inline(line))
        .filter((line) => line !== "")
        .join("\\\n"),
    )
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");
}

/** Cuts text to at most `max` characters, at a word boundary when one is near, with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

const URL_ESCAPES: Record<string, string> = {
  "(": "%28",
  ")": "%29",
  "<": "%3C",
  ">": "%3E",
  " ": "%20",
};

/** A link for an http(s) URL; anything else is shown as escaped text without a link. */
export function link(label: string, url: string | undefined): string {
  const text = inline(label);
  if (url === undefined) return text;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return text;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return text;
  // encodeURIComponent leaves ( and ) alone, and either would end the link destination.
  const href = parsed.href.replace(/[()<> ]/g, (char) => URL_ESCAPES[char] ?? char);
  return `[${text}](${href})`;
}
